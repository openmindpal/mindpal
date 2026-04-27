/**
 * Discord Gateway WebSocket 长连接客户端 (v10)
 *
 * 通过 WebSocket 连接 Discord Gateway，接收 MESSAGE_CREATE 等事件。
 * 实现心跳、Identify、Resume 以及指数退避重连。
 */
import { StructuredLogger } from "@openslin/shared";
import { BaseLongConnectionClient } from "./baseLongConnection";

const _logger = new StructuredLogger({ module: "api:discordGateway" });

const GATEWAY_VERSION = 10;
const INTENTS = 512 | 32768; // GUILD_MESSAGES | MESSAGE_CONTENT

// Discord Gateway Opcodes
const enum GatewayOp {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  Resume = 6,
  Reconnect = 7,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatAck = 11,
}

export interface DiscordGatewayClientOptions {
  botToken: string;
}

export class DiscordGatewayClient extends BaseLongConnectionClient {
  protected readonly logger = _logger;

  private botToken: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval = 41250;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private heartbeatAcked = true;

  constructor(opts: DiscordGatewayClientOptions) {
    super();
    this.botToken = opts.botToken;
  }

  // ─── 公开方法 ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    BaseLongConnectionClient.ensureWs();
    this.stopped = false;
    this.failures = 0;
    const gatewayUrl = await this.fetchGatewayUrl();
    await this.connect(gatewayUrl);
  }

  override stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(1000, "client stop"); } catch { /* ignore */ }
      this.ws = null;
    }
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
    this.heartbeatAcked = true;
    // 首次心跳加 jitter
    const jitter = Math.random() * this.heartbeatInterval;
    setTimeout(() => {
      if (this.stopped) return;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeatAcked) {
          _logger.warn("heartbeat not ACKed, reconnecting");
          this.reconnectNow();
          return;
        }
        this.heartbeatAcked = false;
        this.sendHeartbeat();
      }, this.heartbeatInterval);
    }, jitter);
  }

  private sendHeartbeat(): void {
    this.wsSend(JSON.stringify({ op: GatewayOp.Heartbeat, d: this.seq }));
  }

  // ─── 内部方法 ──────────────────────────────────────────────────────────────

  private async fetchGatewayUrl(): Promise<string> {
    const res = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: `Bot ${this.botToken}` },
    });
    if (!res.ok) throw new Error(`fetchGatewayUrl failed: ${res.status}`);
    const json: any = await res.json();
    const url = String(json?.url ?? "wss://gateway.discord.gg");
    return `${url}/?v=${GATEWAY_VERSION}&encoding=json`;
  }

  private connect(gatewayUrl: string): Promise<void> {
    _logger.info("connecting to Discord Gateway", { url: gatewayUrl.substring(0, 60) });
    let resolved = false;

    return this.connectWs(gatewayUrl, (resolve, reject) => ({
      onOpen: () => {
        _logger.info("Discord Gateway WS connected");
        this.failures = 0;
      },
      onMessage: (data) => {
        this.handleMessage(data, () => {
          if (!resolved) { resolved = true; resolve(); }
        });
      },
      onError: (err) => _logger.error("Discord Gateway WS error", { error: err?.message ?? err }),
      onClose: (code) => {
        _logger.warn("Discord Gateway WS closed", { code });
        this.stopHeartbeat();
        this.ws = null;
        if (!resolved) { resolved = true; reject(new Error(`WS closed: ${code}`)); }
        if (!this.stopped) this.scheduleReconnect(() => this.doReconnect());
      },
    }), 15_000);
  }

  private async doReconnect(): Promise<void> {
    const url = this.resumeGatewayUrl
      ? `${this.resumeGatewayUrl}/?v=${GATEWAY_VERSION}&encoding=json`
      : await this.fetchGatewayUrl();
    await this.connect(url);
  }

  private reconnectNow(): void {
    if (this.ws) {
      try { this.ws.close(4000, "reconnect"); } catch { /* ignore */ }
      this.ws = null;
    }
    this.stopHeartbeat();
    if (!this.stopped) this.scheduleReconnect(() => this.doReconnect());
  }

  private handleMessage(raw: string, onReady: () => void): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    const op = Number(msg?.op ?? -1);

    // 更新序列号
    if (msg.s != null) {
      this.seq = Number(msg.s);
    }

    switch (op) {
      case GatewayOp.Hello:
        this.heartbeatInterval = Number(msg.d?.heartbeat_interval ?? 41250);
        this.startHeartbeat();
        // Hello 后发送 Identify 或 Resume
        if (this.sessionId && this.seq != null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case GatewayOp.HeartbeatAck:
        this.heartbeatAcked = true;
        break;

      case GatewayOp.Dispatch:
        this.handleDispatch(String(msg.t ?? ""), msg.d, onReady);
        break;

      case GatewayOp.Heartbeat:
        // 服务器要求立即发送心跳
        this.sendHeartbeat();
        break;

      case GatewayOp.Reconnect:
        _logger.info("received Reconnect opcode, reconnecting");
        this.reconnectNow();
        break;

      case GatewayOp.InvalidSession:
        _logger.warn("received Invalid Session", { resumable: msg.d });
        if (!msg.d) {
          // 不可恢复，清除 session
          this.sessionId = null;
          this.seq = null;
        }
        // 等待 1-5 秒后重新 Identify
        setTimeout(() => {
          if (this.sessionId) {
            this.sendResume();
          } else {
            this.sendIdentify();
          }
        }, 1000 + Math.random() * 4000);
        break;

      default:
        break;
    }
  }

  private handleDispatch(eventName: string, data: any, onReady: () => void): void {
    if (eventName === "READY") {
      this.sessionId = String(data?.session_id ?? "");
      this.resumeGatewayUrl = data?.resume_gateway_url ?? null;
      _logger.info("Discord Gateway READY", { sessionId: this.sessionId });
      onReady();
      return;
    }

    if (eventName === "RESUMED") {
      _logger.info("Discord Gateway RESUMED");
      onReady();
      return;
    }

    if (eventName === "MESSAGE_CREATE") {
      this.emit("message", data);
      return;
    }

    // 其他事件透传
    this.emit("dispatch", eventName, data);
  }

  private sendIdentify(): void {
    const payload = {
      op: GatewayOp.Identify,
      d: {
        token: this.botToken,
        intents: INTENTS,
        properties: {
          os: "linux",
          browser: "openslin",
          device: "openslin",
        },
      },
    };
    _logger.info("sending Identify");
    this.wsSend(JSON.stringify(payload));
  }

  private sendResume(): void {
    const payload = {
      op: GatewayOp.Resume,
      d: {
        token: this.botToken,
        session_id: this.sessionId,
        seq: this.seq,
      },
    };
    _logger.info("sending Resume", { sessionId: this.sessionId, seq: this.seq });
    this.wsSend(JSON.stringify(payload));
  }
}
