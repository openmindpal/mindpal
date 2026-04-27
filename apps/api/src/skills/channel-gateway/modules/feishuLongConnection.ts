/**
 * 飞书 WebSocket 长连接客户端
 *
 * 通过 WebSocket 订阅飞书事件推送，无需公网 URL。
 */
import { StructuredLogger } from "@openslin/shared";
import { BaseLongConnectionClient } from "./baseLongConnection";

const _logger = new StructuredLogger({ module: "api:feishuWsClient" });

export interface FeishuWsClientOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string; // 默认 https://open.feishu.cn
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000; // 提前 5 分钟刷新 token

export class FeishuWsClient extends BaseLongConnectionClient {
  protected readonly logger = _logger;

  private appId: string;
  private appSecret: string;
  private baseUrl: string;
  private appAccessToken = "";
  private tokenExpiresAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FeishuWsClientOptions) {
    super();
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.baseUrl = opts.baseUrl ?? "https://open.feishu.cn";
  }

  // ─── 公开方法 ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    BaseLongConnectionClient.ensureWs();
    this.stopped = false;
    this.failures = 0;
    await this.refreshToken();
    const wsUrl = await this.getWsEndpoint();
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
      this.wsSend(JSON.stringify({ type: "ping" }));
      // 顺带检查 token 是否快到期
      if (Date.now() > this.tokenExpiresAt - TOKEN_REFRESH_AHEAD_MS) {
        this.refreshToken().catch(e => _logger.error("heartbeat token refresh failed", { error: e?.message }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ─── 内部方法 ──────────────────────────────────────────────────────────────

  private async refreshToken(): Promise<void> {
    const now = Date.now();
    if (this.appAccessToken && now < this.tokenExpiresAt - TOKEN_REFRESH_AHEAD_MS) return;

    const url = `${this.baseUrl}/open-apis/auth/v3/app_access_token/internal`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!res.ok) throw new Error(`refreshToken failed: ${res.status}`);
    const json: any = await res.json();
    if (json.code !== 0) throw new Error(`refreshToken error: ${json.msg ?? JSON.stringify(json)}`);
    this.appAccessToken = String(json.app_access_token ?? json.tenant_access_token ?? "");
    const expireSec = Number(json.expire ?? 7200);
    this.tokenExpiresAt = now + expireSec * 1000;
    _logger.info("feishu token refreshed", { expiresInSec: expireSec });
  }

  private async getWsEndpoint(): Promise<string> {
    await this.refreshToken();
    const url = `${this.baseUrl}/open-apis/callback/ws/endpoint`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.appAccessToken}`,
      },
      body: "{}",
    });
    if (!res.ok) {
      _logger.warn("getWsEndpoint failed, using fallback URL", { status: res.status });
      return `wss://open.feishu.cn/open-apis/ws/v1`;
    }
    const json: any = await res.json();
    const wsUrl = String(json?.data?.url ?? json?.data?.URL ?? "");
    if (!wsUrl) {
      _logger.warn("getWsEndpoint returned empty URL, using fallback");
      return `wss://open.feishu.cn/open-apis/ws/v1`;
    }
    return wsUrl;
  }

  private connect(wsUrl: string): Promise<void> {
    _logger.info("connecting to feishu WS", { url: wsUrl.substring(0, 60) + "..." });
    return this.connectWs(wsUrl, (resolve, _reject) => ({
      onOpen: () => {
        _logger.info("feishu WS connected");
        this.failures = 0;
        this.authenticate();
        this.startHeartbeat();
        resolve();
      },
      onMessage: (data) => this.handleMessage(data),
      onError: (err) => _logger.error("feishu WS error", { error: err?.message ?? err }),
      onClose: (code) => {
        _logger.warn("feishu WS closed", { code });
        this.stopHeartbeat();
        this.ws = null;
        if (!this.stopped) this.scheduleReconnect(() => this.doReconnect());
      },
    }));
  }

  private async doReconnect(): Promise<void> {
    await this.refreshToken();
    const wsUrl = await this.getWsEndpoint();
    await this.connect(wsUrl);
  }

  private authenticate(): void {
    this.wsSend(JSON.stringify({ type: "auth", app_access_token: this.appAccessToken }));
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    const type = String(msg?.type ?? msg?.header?.event_type ?? "");

    // pong / auth_ok 类消息忽略
    if (type === "pong" || type === "auth" || type === "auth_ok") return;

    // 飞书事件消息
    const eventId = String(msg?.header?.event_id ?? msg?.event_id ?? "");
    if (eventId) {
      this.wsSend(JSON.stringify({ type: "ack", event_id: eventId }));
    }
    this.emit("event", msg);
  }
}
