/**
 * Skill RPC Protocol — JSON-RPC over stdio 标准协议定义
 *
 * OS 思维：Skill 是"用户态进程"，Skill Runner 是"进程管理器"。
 * 本协议定义了 Runner 与 Skill 子进程之间的通信契约。
 *
 * 传输层：换行分隔的 JSON（NDJSON / JSON Lines），over stdin/stdout
 * 控制信道：stderr（日志 + 进度）
 *
 * 消息格式遵循 JSON-RPC 2.0 子集：
 * - Request: { jsonrpc: "2.0", id, method, params }
 * - Response: { jsonrpc: "2.0", id, result } | { jsonrpc: "2.0", id, error }
 * - Notification: { jsonrpc: "2.0", method, params } (无 id，无需响应)
 */

/* ================================================================== */
/*  协议版本                                                            */
/* ================================================================== */

export const SKILL_RPC_VERSION = "1.0";
export const SKILL_RPC_JSONRPC = "2.0" as const;

/* ================================================================== */
/*  Device Agent 协议版本管控                                           */
/* ================================================================== */

/** 当前 Device Agent 协议版本 */
export const DEVICE_PROTOCOL_VERSION = "1.0";

/** 最低支持的协议版本 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = "1.0";

/** 所有支持的协议版本列表 */
export const PROTOCOL_VERSIONS = ["1.0"] as const;

/** 协议版本类型 */
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/** Device Agent → API: 协议握手请求 */
export interface ProtocolHandshake {
  type: "protocol.handshake";
  protocolVersion: string;
  agentVersion: string;
  capabilities: string[];
}

/** API → Device Agent: 协议握手确认 */
export interface ProtocolHandshakeAck {
  type: "protocol.handshake.ack";
  negotiatedVersion: string;
  serverVersion: string;
  compatible: boolean;
  deprecationWarning?: string;
  /** 服务端下发的多模态策略（元数据驱动） */
  multimodalPolicy?: DeviceMultimodalPolicy | null;
}

/* ================================================================== */
/*  设备多模态协议类型                                                    */
/* ================================================================== */

/** 设备支持的模态类型 */
export type DeviceModality = "image" | "audio" | "video";

/** 设备多模态能力声明（设备注册/握手时上报） */
export interface DeviceMultimodalCapabilities {
  modalities: DeviceModality[];
  multimodalConfig?: {
    maxFileSize?: number;
    supportedFormats?: Partial<Record<DeviceModality, string[]>>;
  };
}

/** 服务端下发的多模态策略 */
export interface DeviceMultimodalPolicy {
  allowedModalities: DeviceModality[];
  maxFileSizeBytes: number;
  supportedFormats: Partial<Record<DeviceModality, string[]>>;
}

/** 设备多模态附件 */
export interface DeviceAttachment {
  type: "image" | "document" | "voice" | "video";
  mimeType: string;
  name?: string;
  /** base64 data URL */
  dataUrl?: string;
}

/** 设备 → 云端：多模态查询消息 */
export interface DeviceMultimodalQuery {
  type: "device_query";
  sessionId: string;
  conversationId?: string;
  message: string;
  attachments?: DeviceAttachment[];
}

/** 云端 → 设备：流式 AI 响应消息 */
export interface DeviceMultimodalResponse {
  type: "device_response";
  sessionId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
}

/**
 * 检查客户端版本是否与最低版本兼容。
 * 仅比较主版本号（semver major）。
 */
export function isVersionCompatible(clientVersion: string, minVersion: string): boolean {
  const clientMajor = parseMajor(clientVersion);
  const minMajor = parseMajor(minVersion);
  if (clientMajor === null || minMajor === null) return false;
  return clientMajor >= minMajor;
}

/**
 * 在服务端支持的版本列表中选出与客户端兼容的最高版本。
 * 返回 null 表示无兼容版本。
 */
export function negotiateVersion(clientVersion: string, supportedVersions: readonly string[]): string | null {
  const clientMajor = parseMajor(clientVersion);
  if (clientMajor === null) return null;

  let best: string | null = null;
  let bestMajor = -1;
  for (const v of supportedVersions) {
    const major = parseMajor(v);
    if (major === null) continue;
    if (major <= clientMajor && major > bestMajor) {
      best = v;
      bestMajor = major;
    }
  }
  return best;
}

/** 从 semver 字符串中提取主版本号 */
function parseMajor(version: string): number | null {
  const m = /^(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

/* ================================================================== */
/*  请求/响应基础类型                                                     */
/* ================================================================== */

/** JSON-RPC 请求 */
export interface SkillRpcRequest<P = unknown> {
  jsonrpc: typeof SKILL_RPC_JSONRPC;
  id: string | number;
  method: string;
  params: P;
}

/** JSON-RPC 成功响应 */
export interface SkillRpcSuccess<R = unknown> {
  jsonrpc: typeof SKILL_RPC_JSONRPC;
  id: string | number;
  result: R;
}

/** JSON-RPC 错误响应 */
export interface SkillRpcError {
  jsonrpc: typeof SKILL_RPC_JSONRPC;
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** JSON-RPC 通知（无 id，无需响应） */
export interface SkillRpcNotification<P = unknown> {
  jsonrpc: typeof SKILL_RPC_JSONRPC;
  method: string;
  params: P;
}

export type SkillRpcResponse<R = unknown> = SkillRpcSuccess<R> | SkillRpcError;
export type SkillRpcMessage = SkillRpcRequest | SkillRpcResponse | SkillRpcNotification;

/* ================================================================== */
/*  标准错误码（JSON-RPC 2.0 + 自定义扩展）                               */
/* ================================================================== */

export const SKILL_RPC_ERRORS = {
  /** JSON-RPC 标准错误 */
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  /** 自定义错误码（-32000 ~ -32099 服务器端保留范围） */
  EXECUTION_TIMEOUT: -32001,
  EXECUTION_FAILED: -32002,
  RESOURCE_EXHAUSTED: -32003,
  POLICY_VIOLATION: -32004,
  DEPENDENCY_ERROR: -32005,
  CAPABILITY_DENIED: -32006,
} as const;

/* ================================================================== */
/*  skill.initialize — 初始化                                           */
/* ================================================================== */

/** Runner → Skill: 初始化请求 */
export interface SkillInitializeParams {
  /** 协议版本 */
  protocolVersion: string;
  /** Skill 工具引用 */
  toolRef: string;
  /** 执行上下文 */
  context: {
    tenantId: string;
    spaceId: string | null;
    subjectId: string | null;
    traceId: string;
    locale: string;
  };
  /** 能力包络（声明 Skill 可使用的能力） */
  capabilities: {
    /** 允许的出站域名 */
    allowedDomains: string[];
    /** 允许的文件系统路径 */
    allowedPaths: string[];
    /** 是否允许网络访问 */
    networkAccess: boolean;
  };
  /** 资源限制 */
  limits: {
    timeoutMs: number;
    memoryMb: number;
    maxOutputBytes: number;
  };
}

/** Skill → Runner: 初始化响应 */
export interface SkillInitializeResult {
  /** Skill 名称 */
  name: string;
  /** Skill 版本 */
  version: string;
  /** 支持的运行时语言 */
  runtime: "python" | "node" | "go" | "rust" | "other";
  /** Skill 声明的能力需求 */
  requiredCapabilities?: string[];
}

/* ================================================================== */
/*  skill.execute — 执行                                                */
/* ================================================================== */

/** Runner → Skill: 执行请求 */
export interface SkillExecuteParams {
  /** 请求唯一 ID（幂等键） */
  requestId: string;
  /** 输入参数 */
  input: Record<string, unknown>;
  /** 输入摘要 */
  inputDigest: {
    sha256_8: string;
    bytes: number;
  };
  /** 可选执行上下文（可序列化部分，apiFetch 在沙箱中就地构造） */
  context?: {
    locale: string;
    apiBaseUrl?: string;
    authToken?: string;
  };
}

/** Skill → Runner: 执行响应 */
export interface SkillExecuteResult {
  /** 输出数据 */
  output: unknown;
  /** 输出摘要 */
  outputDigest?: {
    sha256_8?: string;
    bytes?: number;
  };
  /** 出站请求摘要 */
  egressSummary?: {
    allowed: number;
    denied: number;
  };
}

/* ================================================================== */
/*  skill.heartbeat — 心跳（Runner → Skill）                            */
/* ================================================================== */

export interface SkillHeartbeatParams {
  ts: number;
}

export interface SkillHeartbeatResult {
  ts: number;
  status: "alive" | "busy";
}

/* ================================================================== */
/*  通知类型（Skill → Runner，无需响应）                                   */
/* ================================================================== */

/** Skill → Runner: 进度通知 */
export interface SkillProgressNotification {
  /** 进度百分比 0-100 */
  progress: number;
  /** 当前阶段描述 */
  phase?: string;
  /** 附加信息 */
  detail?: unknown;
}

/** Skill → Runner: 日志通知 */
export interface SkillLogNotification {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: unknown;
}

/* ================================================================== */
/*  方法名常量                                                          */
/* ================================================================== */

export const SKILL_RPC_METHODS = {
  INITIALIZE: "skill.initialize",
  EXECUTE: "skill.execute",
  HEARTBEAT: "skill.heartbeat",
  SHUTDOWN: "skill.shutdown",
  /** 通知方法 */
  PROGRESS: "skill.progress",
  LOG: "skill.log",
} as const;

/* ================================================================== */
/*  辅助函数                                                            */
/* ================================================================== */

/** 创建 JSON-RPC 请求 */
export function createRpcRequest<P>(id: string | number, method: string, params: P): SkillRpcRequest<P> {
  return { jsonrpc: SKILL_RPC_JSONRPC, id, method, params };
}

/** 创建 JSON-RPC 成功响应 */
export function createRpcSuccess<R>(id: string | number, result: R): SkillRpcSuccess<R> {
  return { jsonrpc: SKILL_RPC_JSONRPC, id, result };
}

/** 创建 JSON-RPC 错误响应 */
export function createRpcError(id: string | number | null, code: number, message: string, data?: unknown): SkillRpcError {
  return { jsonrpc: SKILL_RPC_JSONRPC, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** 创建通知消息 */
export function createRpcNotification<P>(method: string, params: P): SkillRpcNotification<P> {
  return { jsonrpc: SKILL_RPC_JSONRPC, method, params };
}

/** 序列化为 NDJSON 行 */
export function serializeRpcMessage(msg: SkillRpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

/** 从 NDJSON 行反序列化 */
export function parseRpcMessage(line: string): SkillRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && obj.jsonrpc === "2.0") return obj as SkillRpcMessage;
    return null;
  } catch {
    return null;
  }
}

/** 判断是否为请求 */
export function isRpcRequest(msg: SkillRpcMessage): msg is SkillRpcRequest {
  return "method" in msg && "id" in msg;
}

/** 判断是否为通知 */
export function isRpcNotification(msg: SkillRpcMessage): msg is SkillRpcNotification {
  return "method" in msg && !("id" in msg);
}

/** 判断是否为响应 */
export function isRpcResponse(msg: SkillRpcMessage): msg is SkillRpcResponse {
  return !("method" in msg) && "id" in msg;
}

/** 判断是否为错误响应 */
export function isRpcError(msg: SkillRpcMessage): msg is SkillRpcError {
  return "error" in msg;
}
