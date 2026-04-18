/**
 * P2-7 验证：触发器生态 — Connector 框架、环境状态快照
 */
import { describe, it, expect, vi } from "vitest";

/* ================================================================== */
/*  Connector 框架 — 注册/创建/生命周期                                   */
/* ================================================================== */

import {
  registerConnectorFactory,
  createConnector,
  listRegisteredConnectorTypes,
  startConnector,
  stopConnector,
  getActiveConnector,
  upsertConnectorInstance,
  updateConnectorHealth,
  healthCheckAllConnectors,
  type Connector,
  type ConnectorConfig,
  type ConnectorCapabilities,
  type ConnectorHealthResult,
  type InboundEvent,
  type OutboundRequest,
  type OutboundResult,
} from "../lib/connectorFramework";

/** 创建一个 mock Connector 工厂 */
function makeMockConnector(id: string): Connector {
  return {
    id,
    typeName: "test",
    status: "connected",
    capabilities: {
      modes: ["outbound"],
      supportsAck: false,
      supportsAutoReconnect: false,
      supportsBatch: false,
    } satisfies ConnectorCapabilities,

    initialize: vi.fn(async () => {}),
    authenticate: vi.fn(async () => ({ success: true })),
    publish: vi.fn(async (_req: OutboundRequest): Promise<OutboundResult> => ({
      success: true,
      latencyMs: 50,
      retryCount: 0,
    })),
    healthCheck: vi.fn(async (): Promise<ConnectorHealthResult> => ({
      status: "connected",
      latencyMs: 10,
      lastSuccessAt: new Date().toISOString(),
      lastErrorAt: null,
      lastError: null,
      consecutiveFailures: 0,
    })),
    shutdown: vi.fn(async () => {}),
  };
}

function mockPool(queryResults: Record<string, any> = {}) {
  return {
    query: vi.fn(async (sql: string) => {
      for (const [key, val] of Object.entries(queryResults)) {
        if (sql.includes(key)) return val;
      }
      return { rows: [], rowCount: 0 };
    }),
  } as any;
}

describe("Connector 注册表", () => {
  it("registerConnectorFactory + createConnector 创建实例", () => {
    registerConnectorFactory("unit-test-type", (id) => makeMockConnector(id));
    const conn = createConnector("unit-test-type", "conn-1");
    expect(conn).not.toBeNull();
    expect(conn!.id).toBe("conn-1");
    expect(conn!.typeName).toBe("test");
  });

  it("createConnector 对未注册类型返回 null", () => {
    const conn = createConnector("non-existent-type", "conn-x");
    expect(conn).toBeNull();
  });

  it("listRegisteredConnectorTypes 包含已注册类型", () => {
    registerConnectorFactory("another-test", (id) => makeMockConnector(id));
    const types = listRegisteredConnectorTypes();
    expect(types).toContain("another-test");
  });
});

describe("Connector 生命周期", () => {
  it("startConnector 初始化→认证→写入 DB", async () => {
    registerConnectorFactory("lifecycle-test", (id) => makeMockConnector(id));
    const pool = mockPool({ INSERT: { rows: [], rowCount: 1 } });
    const config: ConnectorConfig = {
      typeName: "lifecycle-test",
      endpoint: "https://example.com/api",
      authMethod: "api_key",
    };

    const result = await startConnector({
      pool,
      tenantId: "t1",
      connectorId: "lc-1",
      typeName: "lifecycle-test",
      config,
    });

    expect(result.success).toBe(true);
    expect(pool.query).toHaveBeenCalled();
  });

  it("startConnector 未知类型返回错误", async () => {
    const pool = mockPool();
    const config: ConnectorConfig = {
      typeName: "unknown-type",
      endpoint: "https://example.com",
      authMethod: "none",
    };

    const result = await startConnector({
      pool,
      tenantId: "t1",
      connectorId: "u-1",
      typeName: "unknown-type-xyz",
      config,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown connector type");
  });

  it("stopConnector 关闭连接器", async () => {
    // 先启动
    registerConnectorFactory("stop-test", (id) => makeMockConnector(id));
    const pool = mockPool({ INSERT: { rows: [], rowCount: 1 } });
    await startConnector({
      pool,
      tenantId: "t1",
      connectorId: "stop-1",
      typeName: "stop-test",
      config: { typeName: "stop-test", endpoint: "https://x.com", authMethod: "none" },
    });

    expect(getActiveConnector("stop-1")).not.toBeNull();
    await stopConnector("stop-1");
    expect(getActiveConnector("stop-1")).toBeNull();
  });
});

describe("Connector DB 持久化", () => {
  it("upsertConnectorInstance 执行 UPSERT SQL", async () => {
    const pool = mockPool({ INSERT: { rows: [], rowCount: 1 } });
    await upsertConnectorInstance({
      pool,
      tenantId: "t1",
      connectorId: "c-1",
      typeName: "webhook",
      config: { typeName: "webhook", endpoint: "https://hook.io", authMethod: "hmac" },
      status: "connected",
    });

    expect(pool.query).toHaveBeenCalled();
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql.toLowerCase()).toContain("insert");
    expect(sql.toLowerCase()).toContain("connector_instances");
  });

  it("updateConnectorHealth 更新健康状态", async () => {
    const pool = mockPool({ UPDATE: { rows: [], rowCount: 1 } });
    await updateConnectorHealth({
      pool,
      tenantId: "t1",
      connectorId: "c-1",
      healthResult: {
        status: "connected",
        latencyMs: 15,
        lastSuccessAt: new Date().toISOString(),
        lastErrorAt: null,
        lastError: null,
        consecutiveFailures: 0,
      },
    });

    expect(pool.query).toHaveBeenCalled();
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql.toLowerCase()).toContain("update");
  });
});

describe("ConnectorCapabilities / InboundEvent 类型验证", () => {
  it("ConnectorCapabilities 字段完整", () => {
    const cap: ConnectorCapabilities = {
      modes: ["inbound", "outbound", "bidirectional"],
      inboundEventTypes: ["webhook.received"],
      outboundActions: ["send_message"],
      supportsAck: true,
      supportsAutoReconnect: true,
      supportsBatch: false,
      maxConcurrentConnections: 10,
    };
    expect(cap.modes).toHaveLength(3);
    expect(cap.supportsAck).toBe(true);
  });

  it("InboundEvent 结构正确", () => {
    const event: InboundEvent = {
      eventId: "evt-1",
      connectorId: "c-1",
      eventType: "webhook.received",
      source: "github",
      timestamp: Date.now(),
      payload: { action: "push" },
      idempotencyKey: "idem-key-1",
      requiresAck: true,
    };
    expect(event.eventId).toBe("evt-1");
    expect(event.requiresAck).toBe(true);
  });
});

/* ================================================================== */
/*  环境状态快照 — buildEnvironmentState / queryEntityStatus            */
/* ================================================================== */

import {
  buildEnvironmentState,
  queryEntityStatus,
  getEnvironmentSummary,
  type EnvironmentState,
  type EnvironmentEntity,
  type EnvironmentConstraint,
} from "./environmentState";

describe("buildEnvironmentState", () => {
  it("聚合设备+连接器+模型返回完整快照", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("device_registrations")) {
          return {
            rows: [
              { device_id: "d-1", display_name: "灯", status: "online", last_seen_at: new Date().toISOString(), capabilities: {} },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("connector_instances")) {
          return {
            rows: [
              { id: "c-1", name: "Slack Bot", status: "active", type_name: "slack", updated_at: new Date().toISOString() },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("model_catalog")) {
          return {
            rows: [
              { model_ref: "gpt-4o", provider: "openai", status: "active", degradation_score: 0.1, updated_at: new Date().toISOString() },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const state = await buildEnvironmentState({ pool, tenantId: "t1" });

    expect(state.tenantId).toBe("t1");
    expect(state.entities.length).toBeGreaterThanOrEqual(3);
    expect(state.summary.totalEntities).toBeGreaterThanOrEqual(3);
    expect(state.snapshotAt).toBeTruthy();

    // 设备
    const device = state.entities.find(e => e.kind === "device");
    expect(device).toBeDefined();
    expect(device!.id).toBe("d-1");

    // 连接器
    const connector = state.entities.find(e => e.kind === "connector");
    expect(connector).toBeDefined();
    expect(connector!.status).toBe("online"); // active → online

    // 模型
    const model = state.entities.find(e => e.kind === "model");
    expect(model).toBeDefined();
    expect(model!.status).toBe("online"); // active + low degradation → online
  });

  it("模型退化分数高时生成 constraint", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("model_catalog")) {
          return {
            rows: [
              { model_ref: "gpt-3.5", provider: "openai", status: "active", degradation_score: 0.95, updated_at: new Date().toISOString() },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const state = await buildEnvironmentState({ pool, tenantId: "t1", includeKinds: ["model"] });

    expect(state.constraints.length).toBeGreaterThanOrEqual(1);
    const degradation = state.constraints.find(c => c.kind === "model_degradation");
    expect(degradation).toBeDefined();
    expect(degradation!.severity).toBe("critical"); // >= 0.9
  });

  it("空数据库返回空快照", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as any;

    const state = await buildEnvironmentState({ pool, tenantId: "t1" });

    expect(state.entities).toHaveLength(0);
    expect(state.constraints).toHaveLength(0);
    expect(state.summary.totalEntities).toBe(0);
    expect(state.summary.onlineEntities).toBe(0);
  });

  it("DB 查询出错时不崩溃（降级为空）", async () => {
    const pool = {
      query: vi.fn(async () => { throw new Error("DB down"); }),
    } as any;

    const state = await buildEnvironmentState({ pool, tenantId: "t1" });

    // 各模块查询均出错，但整体不抛异常
    expect(state.entities).toHaveLength(0);
    expect(state.summary.totalEntities).toBe(0);
  });

  it("includeKinds 可限制查询范围", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("device_registrations")) {
          return { rows: [{ device_id: "d-1", display_name: "灯", status: "online", last_seen_at: new Date().toISOString(), capabilities: {} }], rowCount: 1 };
        }
        // 不应查 connector_instances 和 model_catalog
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const state = await buildEnvironmentState({ pool, tenantId: "t1", includeKinds: ["device"] });

    expect(state.entities.length).toBe(1);
    expect(state.entities[0].kind).toBe("device");
  });
});

describe("EnvironmentState 类型验证", () => {
  it("EnvironmentEntity 字段完整", () => {
    const entity: EnvironmentEntity = {
      kind: "device",
      id: "d-1",
      displayName: "智能灯",
      status: "online",
      statusUpdatedAt: new Date().toISOString(),
      attributes: { brightness: 80 },
      lastSeenAt: new Date().toISOString(),
    };
    expect(entity.kind).toBe("device");
    expect(entity.status).toBe("online");
  });

  it("EnvironmentConstraint 字段完整", () => {
    const constraint: EnvironmentConstraint = {
      kind: "model_degradation",
      description: "Model gpt-4 performance degraded",
      severity: "warning",
      source: "model_catalog",
      detectedAt: new Date().toISOString(),
    };
    expect(constraint.severity).toBe("warning");
  });
});

describe("getEnvironmentSummary", () => {
  it("返回摘要统计", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as any;

    const summary = await getEnvironmentSummary({ pool, tenantId: "t1" });

    expect(summary).toHaveProperty("totalEntities");
    expect(summary).toHaveProperty("onlineEntities");
    expect(summary).toHaveProperty("degradedEntities");
    expect(summary).toHaveProperty("offlineEntities");
    expect(summary).toHaveProperty("activeConstraints");
    expect(summary).toHaveProperty("criticalConstraints");
  });
});
