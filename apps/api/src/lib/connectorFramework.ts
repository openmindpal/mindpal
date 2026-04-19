/**
 * Standardized Connector Framework
 *
 * P2-7.1: 定义统一 Connector 接口协议，支持双向通信、回执确认、自动重连。
 * 作为 Skill 扩展层的标准接入方式，将外部系统交互规范化。
 *
 * Connector 生命周期：
 *   initialize → authenticate → subscribe/publish → healthCheck → shutdown
 *
 * 三种通信模式：
 *   - outbound: 平台主动调用外部系统（HTTP/gRPC/MQ）
 *   - inbound:  外部系统推送到平台（Webhook/WebSocket）
 *   - bidirectional: 双向持久连接（WebSocket/长轮询）
 */
import type { Pool } from "pg";
import { getOrCreateBreaker, CircuitOpenError, StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "connectorFramework" });

/** 连接器熔断器默认参数 */
const CONNECTOR_BREAKER_DEFAULTS = {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 2,
  onStateChange: (e: { name: string; from: string; to: string; consecutiveFailures: number }) => {
    _logger.warn("circuit-breaker state change", { name: e.name, from: e.from, to: e.to, failures: e.consecutiveFailures });
  },
} as const;

// ── 核心类型 ────────────────────────────────────────────────

export type ConnectorMode = "outbound" | "inbound" | "bidirectional";
export type ConnectorStatus = "initializing" | "connected" | "disconnected" | "error" | "degraded";

/** Connector 能力声明 */
export interface ConnectorCapabilities {
  /** 支持的通信模式 */
  modes: ConnectorMode[];
  /** 支持的事件类型（入站） */
  inboundEventTypes?: string[];
  /** 支持的操作类型（出站） */
  outboundActions?: string[];
  /** 是否支持回执确认 */
  supportsAck: boolean;
  /** 是否支持自动重连 */
  supportsAutoReconnect: boolean;
  /** 是否支持批量操作 */
  supportsBatch: boolean;
  /** 最大并发连接数 */
  maxConcurrentConnections?: number;
}

/** Connector 配置 */
export interface ConnectorConfig {
  /** 连接器类型名（如 "webhook", "imap", "slack.bot"） */
  typeName: string;
  /** 连接目标 URL/地址 */
  endpoint: string;
  /** 认证方式 */
  authMethod: "none" | "api_key" | "oauth2" | "hmac" | "bearer" | "basic" | "custom";
  /** 认证凭据引用（指向 secret_records） */
  authSecretId?: string | null;
  /** 超时配置 */
  timeoutMs?: number;
  /** 重试策略 */
  retry?: {
    maxRetries: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
  /** 限流配置 */
  rateLimit?: {
    maxPerMinute: number;
    maxConcurrent: number;
  };
  /** 额外的连接器特定配置 */
  extra?: Record<string, unknown>;
}

/** Connector 健康检查结果 */
export interface ConnectorHealthResult {
  status: ConnectorStatus;
  latencyMs: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  detail?: Record<string, unknown>;
}

/** 入站事件信封 */
export interface InboundEvent {
  eventId: string;
  connectorId: string;
  eventType: string;
  source: string;
  timestamp: number;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** 幂等键（去重用） */
  idempotencyKey?: string;
  /** 需要回执确认 */
  requiresAck?: boolean;
}

/** 出站操作请求 */
export interface OutboundRequest {
  connectorId: string;
  action: string;
  payload: Record<string, unknown>;
  /** 幂等键 */
  idempotencyKey?: string;
  /** 超时覆盖 */
  timeoutMs?: number;
  /** 追踪 ID */
  traceId?: string;
}

/** 出站操作结果 */
export interface OutboundResult {
  success: boolean;
  statusCode?: number;
  data?: Record<string, unknown>;
  error?: string;
  latencyMs: number;
  retryCount: number;
}

// ── Connector 接口 ──────────────────────────────────────────

/**
 * 标准 Connector 接口。
 * 所有外部系统连接器必须实现此接口。
 */
export interface Connector {
  /** 连接器 ID */
  readonly id: string;
  /** 连接器类型名 */
  readonly typeName: string;
  /** 当前状态 */
  readonly status: ConnectorStatus;
  /** 能力声明 */
  readonly capabilities: ConnectorCapabilities;

  /**
   * 初始化连接器（加载配置、建立连接池等）。
   * 在 authenticate 之前调用。
   */
  initialize(config: ConnectorConfig): Promise<void>;

  /**
   * 执行认证流程（OAuth token exchange、API key 验证等）。
   */
  authenticate(): Promise<{ success: boolean; error?: string }>;

  /**
   * 订阅入站事件（适用于 inbound/bidirectional 模式）。
   * 返回取消订阅函数。
   */
  subscribe?(handler: (event: InboundEvent) => Promise<void>): Promise<() => void>;

/**
 * 发送出站请求（适用于 outbound/bidirectional 模式）。
 * P0-02: 按 connectorId 维度熔断，熔断时报 CircuitOpenError。
 */
publish?(request: OutboundRequest): Promise<OutboundResult>;

  /**
   * 确认入站事件已处理（回执确认）。
   */
  acknowledge?(eventId: string): Promise<void>;

  /**
   * 健康检查。
   */
  healthCheck(): Promise<ConnectorHealthResult>;

  /**
   * 关闭连接器，释放资源。
   */
  shutdown(): Promise<void>;
}

// ── Connector 注册表 ────────────────────────────────────────

/** Connector 工厂函数类型 */
export type ConnectorFactory = (id: string) => Connector;

const connectorFactories = new Map<string, ConnectorFactory>();

/** 注册 Connector 工厂 */
export function registerConnectorFactory(typeName: string, factory: ConnectorFactory): void {
  connectorFactories.set(typeName, factory);
}

/** 创建 Connector 实例 */
export function createConnector(typeName: string, id: string): Connector | null {
  const factory = connectorFactories.get(typeName);
  if (!factory) return null;
  return factory(id);
}

/** 获取已注册的 Connector 类型列表 */
export function listRegisteredConnectorTypes(): string[] {
  return [...connectorFactories.keys()];
}

// ── DB 持久化 ───────────────────────────────────────────────

export interface ConnectorInstanceRecord {
  connectorId: string;
  tenantId: string;
  spaceId: string | null;
  typeName: string;
  config: ConnectorConfig;
  status: ConnectorStatus;
  healthResult: ConnectorHealthResult | null;
  lastHealthCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 保存/更新 Connector 实例状态到 DB。
 */
export async function upsertConnectorInstance(params: {
  pool: Pool;
  tenantId: string;
  connectorId: string;
  spaceId?: string | null;
  typeName: string;
  config: ConnectorConfig;
  status: ConnectorStatus;
}): Promise<void> {
  await params.pool.query(
    `INSERT INTO connector_instances (id, tenant_id, scope_id, type_name, status, egress_policy, scope_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'space')
     ON CONFLICT (id, tenant_id) DO UPDATE SET
       status = EXCLUDED.status,
       egress_policy = EXCLUDED.egress_policy,
       updated_at = now()`,
    [
      params.connectorId,
      params.tenantId,
      params.spaceId ?? params.tenantId,
      params.typeName,
      params.status,
      JSON.stringify(params.config),
    ],
  );
}

/**
 * 更新 Connector 健康检查结果。
 */
export async function updateConnectorHealth(params: {
  pool: Pool;
  tenantId: string;
  connectorId: string;
  healthResult: ConnectorHealthResult;
}): Promise<void> {
  await params.pool.query(
    `UPDATE connector_instances SET
       status = $3,
       updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [params.connectorId, params.tenantId, params.healthResult.status],
  );
}

// ── Connector 生命周期管理 ──────────────────────────────────

const activeConnectors = new Map<string, Connector>();

/**
 * 启动 Connector 实例（初始化 → 认证 → 就绪）。
 */
export async function startConnector(params: {
  pool: Pool;
  tenantId: string;
  connectorId: string;
  typeName: string;
  config: ConnectorConfig;
}): Promise<{ success: boolean; error?: string }> {
  const { pool, tenantId, connectorId, typeName, config } = params;

  // P0-02: 检查熔断器状态，若该连接器正在熔断则快速失败
  const breaker = getOrCreateBreaker(`connector:${connectorId}`, CONNECTOR_BREAKER_DEFAULTS);
  if (breaker.getState() === "open") {
    return { success: false, error: `Circuit breaker OPEN for connector ${connectorId} — skipping start` };
  }

  const connector = createConnector(typeName, connectorId);
  if (!connector) {
    return { success: false, error: `Unknown connector type: ${typeName}` };
  }

  try {
    await connector.initialize(config);
    const authResult = await connector.authenticate();
    if (!authResult.success) {
      return { success: false, error: `Authentication failed: ${authResult.error}` };
    }

    activeConnectors.set(connectorId, connector);
    await upsertConnectorInstance({ pool, tenantId, connectorId, typeName, config, status: "connected" });
    breaker.recordSuccess();
    return { success: true };
  } catch (err: any) {
    breaker.recordFailure();
    await upsertConnectorInstance({ pool, tenantId, connectorId, typeName, config, status: "error" });
    return { success: false, error: err?.message };
  }
}

/**
 * 停止 Connector 实例。
 */
export async function stopConnector(connectorId: string): Promise<void> {
  const connector = activeConnectors.get(connectorId);
  if (connector) {
    try { await connector.shutdown(); } catch { /* ignore */ }
    activeConnectors.delete(connectorId);
  }
}

/**
 * 获取活跃的 Connector 实例。
 */
export function getActiveConnector(connectorId: string): Connector | null {
  return activeConnectors.get(connectorId) ?? null;
}

/**
 * 批量健康检查所有活跃 Connector。
 */
export async function healthCheckAllConnectors(pool: Pool, tenantId: string): Promise<Map<string, ConnectorHealthResult>> {
  const results = new Map<string, ConnectorHealthResult>();
  for (const [id, connector] of activeConnectors) {
    try {
      const result = await connector.healthCheck();
      results.set(id, result);
      // P0-02: 健康检查成功记录到熔断器
      getOrCreateBreaker(`connector:${id}`, CONNECTOR_BREAKER_DEFAULTS).recordSuccess();
      await updateConnectorHealth({ pool, tenantId, connectorId: id, healthResult: result });
    } catch (err: any) {
      // P0-02: 健康检查失败记录到熔断器
      getOrCreateBreaker(`connector:${id}`, CONNECTOR_BREAKER_DEFAULTS).recordFailure();
      const failResult: ConnectorHealthResult = {
        status: "error",
        latencyMs: 0,
        lastSuccessAt: null,
        lastErrorAt: new Date().toISOString(),
        lastError: err?.message,
        consecutiveFailures: 1,
      };
      results.set(id, failResult);
    }
  }
  return results;
}
