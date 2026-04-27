/**
 * Slack Socket Mode WebSocket 长连接客户端
 *
 * 通过 apps.connections.open 获取 WSS URL，建立 WebSocket 接收事件推送，无需公网 URL。
 */
import { StructuredLogger } from "@openslin/shared";
import { BaseLongConnectionClient } from "./baseLongConnection";

const _logger = new StructuredLogger({ module: "api:slackSocketMode" });

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface SlackSocketClientOptions {
  appToken: string; // xapp- 开头的 App-Level Token
}

export class SlackSocketClient extends BaseLongConnectionClient {
  protected readonly logger = _logger;

  private appToken: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SlackSocketClientOptions) {
    super();
    this.appToken = opts.appToken;
  }

  // ─── 公开方法 ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    BaseLongConnectionClient.ensureWs();
    this.stopped = false;
    this.failures = 0;
    const wsUrl = await this.requestWsUrl();
    await this.connect(wsUrl);
  }

  // ─── 心跳 ─────────────────────────────────────────────────────────────────

  protected override stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Slack Socket Mode 不需要客户端主动 ping，但我们做 WS-level ping 保活
      try {
        if (this.ws && typeof (this.ws as any).ping === "function") {
          (this.ws as any).ping();
        }
      } catch { /* ignore */ }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ─── 内部方法 ──────────────────────────────────────────────────────────────

  /** 调用 apps.connections.open 获取临时 WSS URL */
  private async requestWsUrl(): Promise<string> {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!res.ok) throw new Error(`apps.connections.open failed: HTTP ${res.status}`);
    const json: any = await res.json();
    if (!json?.ok) throw new Error(`apps.connections.open error: ${json?.error ?? JSON.stringify(json)}`);
    const url = String(json.url ?? "");
    if (!url) throw new Error("apps.connections.open returned empty url");
    _logger.info("obtained Slack Socket Mode WSS URL");
    return url;
  }

  private connect(wsUrl: string): Promise<void> {
    _logger.info("connecting to Slack Socket Mode WS", { url: wsUrl.substring(0, 60) + "..." });
    let helloReceived = false;

    return this.connectWs(wsUrl, (resolve, reject) => ({
      onOpen: () => {
        _logger.info("slack WS transport connected, waiting for hello");
      },
      onMessage: (data) => {
        const resolved = this.handleMessage(data);
        if (resolved && !helloReceived) {
          helloReceived = true;
          this.failures = 0;
          this.startHeartbeat();
          resolve();
        }
      },
      onError: (err) => _logger.error("slack WS error", { error: err?.message ?? err }),
      onClose: (code) => {
        _logger.warn("slack WS closed", { code });
        this.stopHeartbeat();
        this.ws = null;
        if (!helloReceived) reject(new Error(`Slack WS closed before hello: ${code}`));
        if (!this.stopped) this.scheduleReconnect(() => this.doReconnect());
      },
    }), 10_000);
  }

  private async doReconnect(): Promise<void> {
    const wsUrl = await this.requestWsUrl();
    await this.connect(wsUrl);
  }

  /**
   * 处理收到的消息，返回 true 表示收到 hello。
   */
  private handleMessage(raw: string): boolean {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return false; }

    const type = String(msg?.type ?? "");

    if (type === "hello") {
      _logger.info("slack WS hello received", { numConnections: msg?.num_connections });
      return true;
    }

    if (type === "disconnect") {
      _logger.warn("slack WS disconnect requested", { reason: msg?.reason });
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
      }
      return false;
    }

    if (type === "events_api") {
      const envelopeId = String(msg?.envelope_id ?? "");
      if (envelopeId) {
        this.wsSend(JSON.stringify({ envelope_id: envelopeId }));
      }
      const payload = msg?.payload;
      if (payload) {
        this.emit("event", payload);
      }
      return false;
    }

    // interactive / slash_commands 等暂忽略
    if (type !== "interactive" && type !== "slash_commands") {
      _logger.debug("slack WS unhandled message type", { type });
    }
    return false;
  }
}
