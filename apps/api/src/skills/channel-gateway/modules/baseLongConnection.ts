/**
 * WebSocket 长连接客户端基类
 *
 * 抽取四个渠道 WS 客户端的公共逻辑：
 * - WebSocket 运行时适配（ws 包 / 原生 WebSocket）
 * - 连接建立 + 事件监听器挂载（兼容 .on / .addEventListener）
 * - 指数退避重连
 * - wsSend / stop
 *
 * 子类只需实现协议差异部分（握手、心跳、消息解析）。
 */
import { EventEmitter } from "events";
import { StructuredLogger } from "@mindpal/shared";

// ─── WebSocket 运行时适配 ───────────────────────────────────────────────────
let _WsImpl: any;
try {
  _WsImpl = eval('require')("ws");
} catch {
  if (typeof globalThis.WebSocket !== "undefined") {
    _WsImpl = globalThis.WebSocket;
  } else {
    _WsImpl = undefined;
  }
}

const MAX_RECONNECT_DELAY_MS = 30_000;

export interface ConnectHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onError: (err: any) => void;
  onClose: (code: number | undefined) => void;
}

export abstract class BaseLongConnectionClient extends EventEmitter {
  protected static readonly WsImpl: any = _WsImpl;

  protected ws: any = null;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected failures = 0;
  protected stopped = false;

  /** 子类提供自己的 logger */
  protected abstract readonly logger: StructuredLogger;

  // ─── 公共方法 ────────────────────────────────────────────────────────────

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ─── 可覆写的钩子 ────────────────────────────────────────────────────────

  /** 停止心跳，默认空实现；有心跳的子类覆写 */
  protected stopHeartbeat(): void { /* noop */ }

  // ─── 受保护的工具方法 ────────────────────────────────────────────────────

  protected static ensureWs(): void {
    if (!_WsImpl) throw new Error("WebSocket 运行时不可用，请安装 ws 包: npm i ws");
  }

  /**
   * 建立 WebSocket 连接并挂载事件监听器。
   *
   * @param url      WebSocket 地址
   * @param handlers 四个事件回调
   * @param timeout  连接超时毫秒（默认 10s）
   * @returns 当 handlers.onOpen 中调用 resolve 时 Promise 完成
   */
  protected connectWs(
    url: string,
    buildHandlers: (resolve: () => void, reject: (err: Error) => void) => ConnectHandlers,
    timeout = 10_000,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.stopped) return reject(new Error("client stopped"));

      const ws = new _WsImpl(url);
      this.ws = ws as any;

      const handlers = buildHandlers(resolve, reject);

      // 标准化 raw → string
      const onMessage = (rawOrEvent: any) => {
        const data = typeof rawOrEvent === "string"
          ? rawOrEvent
          : (rawOrEvent?.data != null ? String(rawOrEvent.data) : String(rawOrEvent));
        handlers.onMessage(data);
      };

      const onClose = (codeOrEvent: any) => {
        const code = typeof codeOrEvent === "number" ? codeOrEvent : codeOrEvent?.code;
        handlers.onClose(code);
      };

      // ws 包用 .on()，原生 WebSocket 用 .addEventListener()
      if (typeof (ws as any).on === "function") {
        (ws as any).on("open", handlers.onOpen);
        (ws as any).on("message", onMessage);
        (ws as any).on("error", handlers.onError);
        (ws as any).on("close", onClose);
      } else {
        (ws as any).addEventListener("open", handlers.onOpen);
        (ws as any).addEventListener("message", onMessage);
        (ws as any).addEventListener("error", handlers.onError);
        (ws as any).addEventListener("close", onClose);
      }

      // 连接超时
      setTimeout(() => {
        if (!this.ws || (this.ws as any).readyState !== 1) {
          reject(new Error("WS connect timeout"));
          try { ws.close(); } catch { /* ignore */ }
        }
      }, timeout);
    });
  }

  protected scheduleReconnect(retryFn: () => Promise<void>): void {
    if (this.stopped) return;
    this.failures++;
    const delay = Math.min(1000 * Math.pow(2, this.failures - 1), MAX_RECONNECT_DELAY_MS);
    this.logger.info("scheduling reconnect", { delayMs: delay, attempt: this.failures });
    this.reconnectTimer = setTimeout(async () => {
      try {
        await retryFn();
      } catch (e: any) {
        this.logger.error("reconnect failed", { error: e?.message });
        if (!this.stopped) this.scheduleReconnect(retryFn);
      }
    }, delay);
  }

  protected wsSend(data: string): void {
    try {
      if (this.ws && (this.ws as any).readyState === 1) {
        (this.ws as any).send(data);
      }
    } catch (e: any) {
      this.logger.error("ws send error", { error: e?.message });
    }
  }
}
