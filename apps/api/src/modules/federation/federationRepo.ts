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

// ════════════════════════════════════════════════════════════════════════════
// Permission Grants - 节点级权限授权
// ════════════════════════════════════════════════════════════════════════════

export type PermissionType = "read" | "write" | "forward" | "audit" | "invoke" | "subscribe";

export type FederationPermissionGrantRow = {
  grantId: string;
  tenantId: string;
  nodeId: string;
  capabilityId: string;
  permissionType: PermissionType;
  grantedBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function toPermissionGrant(r: Record<string, unknown>): FederationPermissionGrantRow {
  return {
    grantId: String(r.grant_id),
    tenantId: String(r.tenant_id),
    nodeId: String(r.node_id),
    capabilityId: String(r.capability_id),
    permissionType: (r.permission_type as PermissionType) ?? "read",
    grantedBy: r.granted_by ? String(r.granted_by) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    revokeReason: r.revoke_reason ? String(r.revoke_reason) : null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function createPermissionGrant(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  capabilityId: string;
  permissionType: PermissionType;
  grantedBy?: string;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FederationPermissionGrantRow> {
  const res = await params.pool.query(
    `
      INSERT INTO federation_permission_grants (tenant_id, node_id, capability_id, permission_type, granted_by, expires_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING *
    `,
    [
      params.tenantId,
      params.nodeId,
      params.capabilityId,
      params.permissionType,
      params.grantedBy ?? null,
      params.expiresAt ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return toPermissionGrant(res.rows[0] as Record<string, unknown>);
}

export async function listPermissionGrants(params: {
  pool: Pool;
  tenantId: string;
  nodeId?: string;
  capabilityId?: string;
  activeOnly?: boolean;
  limit?: number;
}): Promise<FederationPermissionGrantRow[]> {
  const limit = params.limit ?? 100;
  const vals: unknown[] = [params.tenantId, limit];
  const conds = ["tenant_id = $1"];
  if (params.nodeId) {
    vals.push(params.nodeId);
    conds.push(`node_id = $${vals.length}`);
  }
  if (params.capabilityId) {
    vals.push(params.capabilityId);
    conds.push(`capability_id = $${vals.length}`);
  }
  if (params.activeOnly) {
    conds.push("revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())");
  }
  const res = await params.pool.query(
    `SELECT * FROM federation_permission_grants WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $2`,
    vals,
  );
  return (res.rows as Record<string, unknown>[]).map(toPermissionGrant);
}

export async function revokePermissionGrant(params: {
  pool: Pool;
  tenantId: string;
  grantId: string;
  reason?: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    `UPDATE federation_permission_grants SET revoked_at = now(), revoke_reason = $3, updated_at = now() WHERE tenant_id = $1 AND grant_id = $2 AND revoked_at IS NULL RETURNING grant_id`,
    [params.tenantId, params.grantId, params.reason ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function checkPermission(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  capabilityId: string;
  permissionType: PermissionType;
}): Promise<{ allowed: boolean; grant?: FederationPermissionGrantRow }> {
  const res = await params.pool.query(
    `
      SELECT * FROM federation_permission_grants
      WHERE tenant_id = $1 AND node_id = $2 AND capability_id = $3 AND permission_type = $4
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `,
    [params.tenantId, params.nodeId, params.capabilityId, params.permissionType],
  );
  if (!res.rowCount) return { allowed: false };
  return { allowed: true, grant: toPermissionGrant(res.rows[0] as Record<string, unknown>) };
}

// ══════════════════════════════════════════════════════════════════════════════
// User Grants - 用户级跨域授权
// ══════════════════════════════════════════════════════════════════════════════

export type FederationUserGrantRow = {
  userGrantId: string;
  tenantId: string;
  grantorSubject: string;
  granteeNodeId: string;
  granteeSubject: string;
  capabilityId: string | null;
  permissionType: PermissionType;
  scope: "specific" | "all_capabilities";
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function toUserGrant(r: Record<string, unknown>): FederationUserGrantRow {
  return {
    userGrantId: String(r.user_grant_id),
    tenantId: String(r.tenant_id),
    grantorSubject: String(r.grantor_subject),
    granteeNodeId: String(r.grantee_node_id),
    granteeSubject: String(r.grantee_subject),
    capabilityId: r.capability_id ? String(r.capability_id) : null,
    permissionType: (r.permission_type as PermissionType) ?? "read",
    scope: (r.scope as "specific" | "all_capabilities") ?? "specific",
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    revokeReason: r.revoke_reason ? String(r.revoke_reason) : null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function createUserGrant(params: {
  pool: Pool;
  tenantId: string;
  grantorSubject: string;
  granteeNodeId: string;
  granteeSubject: string;
  capabilityId?: string | null;
  permissionType: PermissionType;
  scope?: "specific" | "all_capabilities";
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FederationUserGrantRow> {
  const res = await params.pool.query(
    `
      INSERT INTO federation_user_grants (tenant_id, grantor_subject, grantee_node_id, grantee_subject, capability_id, permission_type, scope, expires_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *
    `,
    [
      params.tenantId,
      params.grantorSubject,
      params.granteeNodeId,
      params.granteeSubject,
      params.capabilityId ?? null,
      params.permissionType,
      params.scope ?? "specific",
      params.expiresAt ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return toUserGrant(res.rows[0] as Record<string, unknown>);
}

export async function listUserGrants(params: {
  pool: Pool;
  tenantId: string;
  grantorSubject?: string;
  granteeNodeId?: string;
  granteeSubject?: string;
  activeOnly?: boolean;
  limit?: number;
}): Promise<FederationUserGrantRow[]> {
  const limit = params.limit ?? 100;
  const vals: unknown[] = [params.tenantId, limit];
  const conds = ["tenant_id = $1"];
  if (params.grantorSubject) {
    vals.push(params.grantorSubject);
    conds.push(`grantor_subject = $${vals.length}`);
  }
  if (params.granteeNodeId) {
    vals.push(params.granteeNodeId);
    conds.push(`grantee_node_id = $${vals.length}`);
  }
  if (params.granteeSubject) {
    vals.push(params.granteeSubject);
    conds.push(`grantee_subject = $${vals.length}`);
  }
  if (params.activeOnly) {
    conds.push("revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())");
  }
  const res = await params.pool.query(
    `SELECT * FROM federation_user_grants WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $2`,
    vals,
  );
  return (res.rows as Record<string, unknown>[]).map(toUserGrant);
}

export async function revokeUserGrant(params: {
  pool: Pool;
  tenantId: string;
  userGrantId: string;
  reason?: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    `UPDATE federation_user_grants SET revoked_at = now(), revoke_reason = $3, updated_at = now() WHERE tenant_id = $1 AND user_grant_id = $2 AND revoked_at IS NULL RETURNING user_grant_id`,
    [params.tenantId, params.userGrantId, params.reason ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// Content Policies - 内容策略
// ══════════════════════════════════════════════════════════════════════════════

export type ContentPolicyType = "usage_restriction" | "lifecycle" | "redaction" | "encryption";
export type ContentPolicyTargetType = "all" | "capability" | "node" | "user";

export type FederationContentPolicyRow = {
  policyId: string;
  tenantId: string;
  name: string;
  policyType: ContentPolicyType;
  targetType: ContentPolicyTargetType;
  targetId: string | null;
  rules: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

function toContentPolicy(r: Record<string, unknown>): FederationContentPolicyRow {
  return {
    policyId: String(r.policy_id),
    tenantId: String(r.tenant_id),
    name: String(r.name ?? ""),
    policyType: (r.policy_type as ContentPolicyType) ?? "usage_restriction",
    targetType: (r.target_type as ContentPolicyTargetType) ?? "all",
    targetId: r.target_id ? String(r.target_id) : null,
    rules: (r.rules as Record<string, unknown>) ?? {},
    priority: Number(r.priority ?? 100),
    enabled: Boolean(r.enabled ?? true),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function createContentPolicy(params: {
  pool: Pool;
  tenantId: string;
  name: string;
  policyType: ContentPolicyType;
  targetType?: ContentPolicyTargetType;
  targetId?: string | null;
  rules: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}): Promise<FederationContentPolicyRow> {
  const res = await params.pool.query(
    `
      INSERT INTO federation_content_policies (tenant_id, name, policy_type, target_type, target_id, rules, priority, enabled)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      RETURNING *
    `,
    [
      params.tenantId,
      params.name,
      params.policyType,
      params.targetType ?? "all",
      params.targetId ?? null,
      JSON.stringify(params.rules),
      params.priority ?? 100,
      params.enabled ?? true,
    ],
  );
  return toContentPolicy(res.rows[0] as Record<string, unknown>);
}

export async function updateContentPolicy(params: {
  pool: Pool;
  tenantId: string;
  policyId: string;
  name?: string;
  rules?: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}): Promise<FederationContentPolicyRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [params.tenantId, params.policyId];
  let idx = 3;
  if (params.name !== undefined) {
    sets.push(`name = $${idx++}`);
    vals.push(params.name);
  }
  if (params.rules !== undefined) {
    sets.push(`rules = $${idx++}::jsonb`);
    vals.push(JSON.stringify(params.rules));
  }
  if (params.priority !== undefined) {
    sets.push(`priority = $${idx++}`);
    vals.push(params.priority);
  }
  if (params.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    vals.push(params.enabled);
  }
  if (!sets.length) return getContentPolicy({ pool: params.pool, tenantId: params.tenantId, policyId: params.policyId });
  sets.push("updated_at = now()");
  const res = await params.pool.query(
    `UPDATE federation_content_policies SET ${sets.join(", ")} WHERE tenant_id = $1 AND policy_id = $2 RETURNING *`,
    vals,
  );
  if (!res.rowCount) return null;
  return toContentPolicy(res.rows[0] as Record<string, unknown>);
}

export async function getContentPolicy(params: {
  pool: Pool;
  tenantId: string;
  policyId: string;
}): Promise<FederationContentPolicyRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM federation_content_policies WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1",
    [params.tenantId, params.policyId],
  );
  if (!res.rowCount) return null;
  return toContentPolicy(res.rows[0] as Record<string, unknown>);
}

export async function listContentPolicies(params: {
  pool: Pool;
  tenantId: string;
  policyType?: ContentPolicyType;
  enabledOnly?: boolean;
  limit?: number;
}): Promise<FederationContentPolicyRow[]> {
  const limit = params.limit ?? 100;
  const vals: unknown[] = [params.tenantId, limit];
  const conds = ["tenant_id = $1"];
  if (params.policyType) {
    vals.push(params.policyType);
    conds.push(`policy_type = $${vals.length}`);
  }
  if (params.enabledOnly) {
    conds.push("enabled = true");
  }
  const res = await params.pool.query(
    `SELECT * FROM federation_content_policies WHERE ${conds.join(" AND ")} ORDER BY priority ASC, created_at DESC LIMIT $2`,
    vals,
  );
  return (res.rows as Record<string, unknown>[]).map(toContentPolicy);
}

export async function deleteContentPolicy(params: {
  pool: Pool;
  tenantId: string;
  policyId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM federation_content_policies WHERE tenant_id = $1 AND policy_id = $2",
    [params.tenantId, params.policyId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// Audit Logs - 跨域审计日志
// ══════════════════════════════════════════════════════════════════════════════

export type AuditDecision = "allowed" | "denied" | "rate_limited" | "policy_blocked";
export type AuditOperationType = "permission_check" | "data_access" | "capability_invoke" | "grant_change";

export type FederationAuditLogRow = {
  logId: string;
  tenantId: string;
  correlationId: string | null;
  nodeId: string | null;
  direction: "inbound" | "outbound" | "internal";
  operationType: AuditOperationType;
  subjectId: string | null;
  targetCapability: string | null;
  permissionType: string | null;
  decision: AuditDecision;
  decisionReason: string | null;
  policyIds: string[];
  requestDigest: Record<string, unknown> | null;
  responseDigest: Record<string, unknown> | null;
  latencyMs: number | null;
  clientIp: string | null;
  userAgent: string | null;
  createdAt: string;
};

function toAuditLog(r: Record<string, unknown>): FederationAuditLogRow {
  return {
    logId: String(r.log_id),
    tenantId: String(r.tenant_id),
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
    nodeId: r.node_id ? String(r.node_id) : null,
    direction: (r.direction as "inbound" | "outbound" | "internal") ?? "internal",
    operationType: (r.operation_type as AuditOperationType) ?? "permission_check",
    subjectId: r.subject_id ? String(r.subject_id) : null,
    targetCapability: r.target_capability ? String(r.target_capability) : null,
    permissionType: r.permission_type ? String(r.permission_type) : null,
    decision: (r.decision as AuditDecision) ?? "denied",
    decisionReason: r.decision_reason ? String(r.decision_reason) : null,
    policyIds: Array.isArray(r.policy_ids) ? r.policy_ids.map(String) : [],
    requestDigest: (r.request_digest as Record<string, unknown>) ?? null,
    responseDigest: (r.response_digest as Record<string, unknown>) ?? null,
    latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
    clientIp: r.client_ip ? String(r.client_ip) : null,
    userAgent: r.user_agent ? String(r.user_agent) : null,
    createdAt: String(r.created_at ?? ""),
  };
}

export async function createAuditLog(params: {
  pool: Pool;
  tenantId: string;
  correlationId?: string | null;
  nodeId?: string | null;
  direction: "inbound" | "outbound" | "internal";
  operationType: AuditOperationType;
  subjectId?: string | null;
  targetCapability?: string | null;
  permissionType?: string | null;
  decision: AuditDecision;
  decisionReason?: string | null;
  policyIds?: string[];
  requestDigest?: Record<string, unknown> | null;
  responseDigest?: Record<string, unknown> | null;
  latencyMs?: number | null;
  clientIp?: string | null;
  userAgent?: string | null;
}): Promise<FederationAuditLogRow> {
  const res = await params.pool.query(
    `
      INSERT INTO federation_audit_logs (
        tenant_id, correlation_id, node_id, direction, operation_type,
        subject_id, target_capability, permission_type, decision, decision_reason,
        policy_ids, request_digest, response_digest, latency_ms, client_ip, user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16)
      RETURNING *
    `,
    [
      params.tenantId,
      params.correlationId ?? null,
      params.nodeId ?? null,
      params.direction,
      params.operationType,
      params.subjectId ?? null,
      params.targetCapability ?? null,
      params.permissionType ?? null,
      params.decision,
      params.decisionReason ?? null,
      params.policyIds ?? [],
      params.requestDigest ? JSON.stringify(params.requestDigest) : null,
      params.responseDigest ? JSON.stringify(params.responseDigest) : null,
      params.latencyMs ?? null,
      params.clientIp ?? null,
      params.userAgent ?? null,
    ],
  );
  return toAuditLog(res.rows[0] as Record<string, unknown>);
}

export async function listAuditLogs(params: {
  pool: Pool;
  tenantId: string;
  nodeId?: string;
  correlationId?: string;
  subjectId?: string;
  decision?: AuditDecision;
  limit?: number;
}): Promise<FederationAuditLogRow[]> {
  const limit = params.limit ?? 100;
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
  if (params.subjectId) {
    vals.push(params.subjectId);
    conds.push(`subject_id = $${vals.length}`);
  }
  if (params.decision) {
    vals.push(params.decision);
    conds.push(`decision = $${vals.length}`);
  }
  const res = await params.pool.query(
    `SELECT * FROM federation_audit_logs WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $2`,
    vals,
  );
  return (res.rows as Record<string, unknown>[]).map(toAuditLog);
}
