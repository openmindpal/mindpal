/**
 * connectorConfigRepo.ts — 统一连接器配置存储
 *
 * 替代 imapRepo / smtpRepo / exchangeRepo 中的特定配置表读写，
 * 所有连接器配置统一存储在 connector_configs 表的 JSONB config 字段中，
 * 由 connector_types.config_schema 元数据驱动校验。
 *
 * 新增连接器类型无需新建表或写新 repo，只需注册 configSchema 即可。
 */
import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

// ── 通用配置行 ──────────────────────────────────────────────────

export type ConnectorConfigRow = {
  connectorInstanceId: string;
  tenantId: string;
  typeName: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): ConnectorConfigRow {
  return {
    connectorInstanceId: r.connector_instance_id,
    tenantId: r.tenant_id,
    typeName: r.type_name,
    config: typeof r.config === "object" && r.config !== null ? r.config : {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────

export async function upsertConnectorConfig(params: {
  pool: Q;
  connectorInstanceId: string;
  tenantId: string;
  typeName: string;
  config: Record<string, unknown>;
}): Promise<ConnectorConfigRow> {
  const res = await params.pool.query(
    `
      INSERT INTO connector_configs (connector_instance_id, tenant_id, type_name, config)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (connector_instance_id)
      DO UPDATE SET
        type_name = EXCLUDED.type_name,
        config = EXCLUDED.config,
        updated_at = now()
      RETURNING *
    `,
    [params.connectorInstanceId, params.tenantId, params.typeName, JSON.stringify(params.config)],
  );
  return toRow(res.rows[0]);
}

export async function getConnectorConfig(params: {
  pool: Pool;
  tenantId: string;
  connectorInstanceId: string;
}): Promise<ConnectorConfigRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM connector_configs WHERE tenant_id = $1 AND connector_instance_id = $2 LIMIT 1",
    [params.tenantId, params.connectorInstanceId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function deleteConnectorConfig(params: {
  pool: Q;
  tenantId: string;
  connectorInstanceId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM connector_configs WHERE tenant_id = $1 AND connector_instance_id = $2",
    [params.tenantId, params.connectorInstanceId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── configSchema 校验 ────────────────────────────────────────────

/**
 * 获取连接器类型的 configSchema（用于校验 config JSONB 结构）
 */
export async function getConnectorTypeConfigSchema(params: {
  pool: Pool;
  typeName: string;
}): Promise<Record<string, unknown> | null> {
  const res = await params.pool.query(
    "SELECT config_schema FROM connector_types WHERE name = $1 LIMIT 1",
    [params.typeName],
  );
  if (!res.rowCount || !res.rows[0].config_schema) return null;
  return res.rows[0].config_schema;
}

/**
 * 简易 JSON Schema 校验：检查 required 字段是否存在。
 * 后续可替换为 ajv 等成熟校验器。
 */
export function validateConnectorConfig(
  config: Record<string, unknown>,
  configSchema: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const required = Array.isArray((configSchema as any).required)
    ? ((configSchema as any).required as string[])
    : [];
  for (const field of required) {
    if (config[field] === undefined || config[field] === null) {
      return { ok: false, reason: `missing_required_field:${field}` };
    }
  }
  return { ok: true };
}

// ── 便捷方法：带 configSchema 校验的 upsert ─────────────────────

export async function upsertConnectorConfigWithValidation(params: {
  pool: Q;
  readPool: Pool;
  connectorInstanceId: string;
  tenantId: string;
  typeName: string;
  config: Record<string, unknown>;
}): Promise<{ ok: true; row: ConnectorConfigRow } | { ok: false; reason: string }> {
  const schema = await getConnectorTypeConfigSchema({ pool: params.readPool, typeName: params.typeName });
  if (schema) {
    const validation = validateConnectorConfig(params.config, schema);
    if (!validation.ok) return validation;
  }
  const row = await upsertConnectorConfig({
    pool: params.pool,
    connectorInstanceId: params.connectorInstanceId,
    tenantId: params.tenantId,
    typeName: params.typeName,
    config: params.config,
  });
  return { ok: true, row };
}
