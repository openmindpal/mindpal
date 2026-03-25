import type { Pool } from "pg";

// ---- Types ----

export type FederationDirection = "inbound_only" | "outbound_only" | "bi";
export type FederationAuthMethod = "bearer" | "hmac" | "mtls" | "none";
export type FederationNodeStatus = "pending" | "active" | "suspended" | "revoked";
export type FederationTrustLevel = "untrusted" | "trusted" | "verified";
export type EnvelopeLogStatus = "pending" | "delivered" | "failed" | "rejected";

export type FederationNodeRow = {
  nodeId: string;
  tenantId: string;
  name: string;
  endpoint: string;
  direction: FederationDirection;
  authMethod: FederationAuthMethod;
  authSecretId: string | null;
  status: FederationNodeStatus;
  trustLevel: FederationTrustLevel;
  metadata: Record<string, unknown>;
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FederationEnvelopeLogRow = {
  logId: string;
  tenantId: string;
  nodeId: string;
  direction: "inbound" | "outbound";
  envelopeType: string;
  correlationId: string | null;
  payloadDigest: unknown;
  status: EnvelopeLogStatus;
  errorMessage: string | null;
  latencyMs: number | null;
  createdAt: string;
};

export type FederationNodeCapabilityRow = {
  capabilityId: string;
  tenantId: string;
  nodeId: string;
  capabilityType: string;
  capabilityRef: string;
  version: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

// ---- Mappers ----

function toNode(r: Record<string, unknown>): FederationNodeRow {
  return {
    nodeId: String(r.node_id),
    tenantId: String(r.tenant_id),
    name: String(r.name ?? ""),
    endpoint: String(r.endpoint ?? ""),
    direction: (r.direction as FederationDirection) ?? "bi",
    authMethod: (r.auth_method as FederationAuthMethod) ?? "bearer",
    authSecretId: r.auth_secret_id ? String(r.auth_secret_id) : null,
    status: (r.status as FederationNodeStatus) ?? "pending",
    trustLevel: (r.trust_level as FederationTrustLevel) ?? "untrusted",
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    lastHeartbeat: r.last_heartbeat ? String(r.last_heartbeat) : null,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function toEnvelopeLog(r: Record<string, unknown>): FederationEnvelopeLogRow {
  return {
    logId: String(r.log_id),
    tenantId: String(r.tenant_id),
    nodeId: String(r.node_id),
    direction: (r.direction as "inbound" | "outbound") ?? "outbound",
    envelopeType: String(r.envelope_type ?? ""),
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
    payloadDigest: r.payload_digest ?? null,
    status: (r.status as EnvelopeLogStatus) ?? "pending",
    errorMessage: r.error_message ? String(r.error_message) : null,
    latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
    createdAt: String(r.created_at ?? ""),
  };
}

function toCapability(r: Record<string, unknown>): FederationNodeCapabilityRow {
  return {
    capabilityId: String(r.capability_id),
    tenantId: String(r.tenant_id),
    nodeId: String(r.node_id),
    capabilityType: String(r.capability_type ?? ""),
    capabilityRef: String(r.capability_ref ?? ""),
    version: r.version ? String(r.version) : null,
    status: String(r.status ?? "available"),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

// ---- Federation Nodes CRUD ----

export async function createFederationNode(params: {
  pool: Pool;
  tenantId: string;
  name: string;
  endpoint: string;
  direction?: FederationDirection;
  authMethod?: FederationAuthMethod;
  authSecretId?: string | null;
  status?: FederationNodeStatus;
  trustLevel?: FederationTrustLevel;
  metadata?: Record<string, unknown>;
}): Promise<FederationNodeRow> {
  const res = await params.pool.query(
    `
      INSERT INTO federation_nodes (tenant_id, name, endpoint, direction, auth_method, auth_secret_id, status, trust_level, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *
    `,
    [
      params.tenantId,
      params.name,
      params.endpoint,
      params.direction ?? "bi",
      params.authMethod ?? "bearer",
      params.authSecretId ?? null,
      params.status ?? "pending",
      params.trustLevel ?? "untrusted",
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return toNode(res.rows[0] as Record<string, unknown>);
}

export async function updateFederationNode(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  name?: string;
  endpoint?: string;
  direction?: FederationDirection;
  authMethod?: FederationAuthMethod;
  authSecretId?: string | null;
  status?: FederationNodeStatus;
  trustLevel?: FederationTrustLevel;
  metadata?: Record<string, unknown>;
}): Promise<FederationNodeRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [params.tenantId, params.nodeId];
  let idx = 3;

  if (params.name !== undefined) {
    sets.push(`name = $${idx++}`);
    vals.push(params.name);
  }
  if (params.endpoint !== undefined) {
    sets.push(`endpoint = $${idx++}`);
    vals.push(params.endpoint);
  }
  if (params.direction !== undefined) {
    sets.push(`direction = $${idx++}`);
    vals.push(params.direction);
  }
  if (params.authMethod !== undefined) {
    sets.push(`auth_method = $${idx++}`);
    vals.push(params.authMethod);
  }
  if (params.authSecretId !== undefined) {
    sets.push(`auth_secret_id = $${idx++}`);
    vals.push(params.authSecretId);
  }
  if (params.status !== undefined) {
    sets.push(`status = $${idx++}`);
    vals.push(params.status);
  }
  if (params.trustLevel !== undefined) {
    sets.push(`trust_level = $${idx++}`);
    vals.push(params.trustLevel);
  }
  if (params.metadata !== undefined) {
    sets.push(`metadata = $${idx++}::jsonb`);
    vals.push(JSON.stringify(params.metadata));
  }

  if (!sets.length) return getFederationNode({ pool: params.pool, tenantId: params.tenantId, nodeId: params.nodeId });

  sets.push("updated_at = now()");

  const res = await params.pool.query(
    `UPDATE federation_nodes SET ${sets.join(", ")} WHERE tenant_id = $1 AND node_id = $2 RETURNING *`,
    vals,
  );
  if (!res.rowCount) return null;
  return toNode(res.rows[0] as Record<string, unknown>);
}

export async function getFederationNode(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
}): Promise<FederationNodeRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM federation_nodes WHERE tenant_id = $1 AND node_id = $2 LIMIT 1",
    [params.tenantId, params.nodeId],
  );
  if (!res.rowCount) return null;
  return toNode(res.rows[0] as Record<string, unknown>);
}

export async function listFederationNodes(params: {
  pool: Pool;
  tenantId: string;
  status?: FederationNodeStatus;
  limit?: number;
  offset?: number;
}): Promise<FederationNodeRow[]> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const vals: unknown[] = [params.tenantId, limit, offset];
  let where = "tenant_id = $1";
  if (params.status) {
    where += " AND status = $4";
    vals.push(params.status);
  }
  const res = await params.pool.query(
    `SELECT * FROM federation_nodes WHERE ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    vals,
  );
  return (res.rows as Record<string, unknown>[]).map(toNode);
}

export async function deleteFederationNode(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
}): Promise<boolean> {
  // 先删除关联的能力和日志
  await params.pool.query(
    "DELETE FROM federation_node_capabilities WHERE tenant_id = $1 AND node_id = $2",
    [params.tenantId, params.nodeId],
  );
  await params.pool.query(
    "DELETE FROM federation_envelope_logs WHERE tenant_id = $1 AND node_id = $2",
    [params.tenantId, params.nodeId],
  );
  const res = await params.pool.query(
    "DELETE FROM federation_nodes WHERE tenant_id = $1 AND node_id = $2",
    [params.tenantId, params.nodeId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function updateHeartbeat(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
}): Promise<void> {
  await params.pool.query(
    "UPDATE federation_nodes SET last_heartbeat = now(), updated_at = now() WHERE tenant_id = $1 AND node_id = $2",
    [params.tenantId, params.nodeId],
  );
}

// ---- Envelope Logs ----

export async function createEnvelopeLog(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  direction: "inbound" | "outbound";
  envelopeType: string;
  correlationId?: string | null;
  payloadDigest?: unknown;
  status?: EnvelopeLogStatus;
  errorMessage?: string | null;
  latencyMs?: number | null;
}): Promise<FederationEnvelopeLogRow> {
  const res = await params.pool.query(
    `
      INSERT INTO federation_envelope_logs (tenant_id, node_id, direction, envelope_type, correlation_id, payload_digest, status, error_message, latency_ms)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
      RETURNING *
    `,
    [
      params.tenantId,
      params.nodeId,
      params.direction,
      params.envelopeType,
      params.correlationId ?? null,
      params.payloadDigest ? JSON.stringify(params.payloadDigest) : null,
      params.status ?? "pending",
      params.errorMessage ?? null,
      params.latencyMs ?? null,
    ],
  );
  return toEnvelopeLog(res.rows[0] as Record<string, unknown>);
}

export async function listEnvelopeLogs(params: {
  pool: Pool;
  tenantId: string;
  nodeId?: string;
  correlationId?: string;
  limit?: number;
}): Promise<FederationEnvelopeLogRow[]> {
  const limit = params.limit ?? 50;
  const vals: unknown[] = [params.tenantId, limit];
  const conds = ["tenant_id = $1"];
  if (params.nodeId) {
    vals.push(params.nodeId);
    conds.push(`node_id = $${vals.length}`);
  }
  if (params.correlationId) {
    vals.push(params.correlationId);
    conds.push(`correlation_id = $${vals.length}`);
  }
  const res = await params.pool.query(
    `SELECT * FROM federation_envelope_logs WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $2`,
    vals,
  );
  return (res.rows as Record<string, unknown>[]).map(toEnvelopeLog);
}

// ---- Capabilities ----

export async function upsertNodeCapability(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  capabilityType: string;
  capabilityRef: string;
  version?: string | null;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<FederationNodeCapabilityRow> {
  const res = await params.pool.query(
    `
      INSERT INTO federation_node_capabilities (tenant_id, node_id, capability_type, capability_ref, version, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (tenant_id, node_id, capability_type, capability_ref)
      DO UPDATE SET version = EXCLUDED.version, status = EXCLUDED.status, metadata = EXCLUDED.metadata, updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.nodeId,
      params.capabilityType,
      params.capabilityRef,
      params.version ?? null,
      params.status ?? "available",
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return toCapability(res.rows[0] as Record<string, unknown>);
}

export async function listNodeCapabilities(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
}): Promise<FederationNodeCapabilityRow[]> {
  const res = await params.pool.query(
    "SELECT * FROM federation_node_capabilities WHERE tenant_id = $1 AND node_id = $2 ORDER BY created_at DESC",
    [params.tenantId, params.nodeId],
  );
  return (res.rows as Record<string, unknown>[]).map(toCapability);
}
