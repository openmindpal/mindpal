/**
 * 钉钉 Stream 长连接客户端
 *
 * 通过 WebSocket 订阅钉钉事件推送，无需公网 URL。
 */
import { StructuredLogger } from "@openslin/shared";
import { BaseLongConnectionClient } from "./baseLongConnection";

const _logger = new StructuredLogger({ module: "api:dingtalkStream" });

export interface DingtalkStreamClientOptions {
  appKey: string;
  appSecret: string;
}

export class DingtalkStreamClient extends BaseLongConnectionClient {
  protected readonly logger = _logger;

  private appKey: string;
  private appSecret: string;

  constructor(opts: DingtalkStreamClientOptions) {
    super();
    this.appKey = opts.appKey;
    this.appSecret = opts.appSecret;
  }

  // ─── 公开方法 ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    BaseLongConnectionClient.ensureWs();
    this.stopped = false;
    this.failures = 0;
    const { endpoint, ticket } = await this.openConnection();
    await this.connect(endpoint, ticket);
  }

  // ─── 内部方法 ──────────────────────────────────────────────────────────────

  private async openConnection(): Promise<{ endpoint: string; ticket: string }> {
    const url = "https://api.dingtalk.com/v1.0/gateway/connections/open";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.appKey,
        clientSecret: this.appSecret,
        subscriptions: [{ type: "EVENT", topic: "/v1.0/im/bot/messages/get" }],
        ua: "openslin",
      }),
    });
    if (!res.ok) throw new Error(`openConnection failed: ${res.status}`);
    const json: any = await res.json();
    const endpoint = String(json?.endpoint ?? "");
    const ticket = String(json?.ticket ?? "");
    if (!endpoint || !ticket) throw new Error("openConnection returned empty endpoint/ticket");
    _logger.info("dingtalk stream connection opened", { endpoint: endpoint.substring(0, 60) });
    return { endpoint, ticket };
  }

  private connect(endpoint: string, ticket: string): Promise<void> {
    const wsUrl = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;
    _logger.info("connecting to dingtalk stream", { url: wsUrl.substring(0, 80) + "..." });

    return this.connectWs(wsUrl, (resolve, _reject) => ({
      onOpen: () => {
        _logger.info("dingtalk stream connected");
        this.failures = 0;
        resolve();
      },
      onMessage: (data) => this.handleMessage(data),
      onError: (err) => _logger.error("dingtalk stream WS error", { error: err?.message ?? err }),
      onClose: (code) => {
        _logger.warn("dingtalk stream WS closed", { code });
        this.ws = null;
        if (!this.stopped) this.scheduleReconnect(() => this.doReconnect());
      },
    }));
  }

  private async doReconnect(): Promise<void> {
    const { endpoint, ticket } = await this.openConnection();
    await this.connect(endpoint, ticket);
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    const type = String(msg?.type ?? "");
    const topic = String(msg?.headers?.topic ?? "");

    // PING 心跳 → 回复 PONG ACK
    if (type === "SYSTEM" && topic === "PING") {
      this.wsSend(JSON.stringify({
        code: 200,
        headers: {
          contentType: "application/json",
          messageId: msg?.headers?.messageId ?? "",
        },
        message: "OK",
        data: "",
      }));
      return;
    }

    // 事件消息
    if (type === "EVENT") {
      let parsed: any;
      try {
        parsed = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
      } catch {
        parsed = msg.data;
      }
      this.emit("event", parsed);
      // 回复 ACK
      this.wsSend(JSON.stringify({
        code: 200,
        headers: {
          contentType: "application/json",
          messageId: msg?.headers?.messageId ?? "",
        },
        message: "OK",
        data: "",
      }));
    }
  }
}
