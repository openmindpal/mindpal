import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError, Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@mindpal/shared";
import {
  createFederationNode,
  updateFederationNode,
  getFederationNode,
  listFederationNodes,
  deleteFederationNode,
  listEnvelopeLogs,
  listNodeCapabilities,
  upsertNodeCapability,
  updateHeartbeat,
  // Permission Grants
  createPermissionGrant,
  listPermissionGrants,
  revokePermissionGrant,
  checkPermission,
  // User Grants
  createUserGrant,
  listUserGrants,
  revokeUserGrant,
  // Content Policies
  createContentPolicy,
  updateContentPolicy,
  getContentPolicy,
  listContentPolicies,
  deleteContentPolicy,
  // Audit Logs
  createAuditLog,
  listAuditLogs,
  type PermissionType,
  type ContentPolicyType,
} from "../../modules/federation/federationRepo";
import {
  getFederationGatewayStatus,
  testFederationNode,
  handleInboundFederationEnvelope,
  type FederationEnvelopeV1,
} from "../../skills/collab-runtime/modules/federationGateway";

function ensureFederationAuthConfig(params: {
  authMethod?: "bearer" | "hmac" | "mtls" | "none";
  authSecretId?: string | null;
}) {
  if (!params.authMethod || params.authMethod === "none") return;
  if (!params.authSecretId) {
    throw new AppError({
      errorCode: "FEDERATION_AUTH_SECRET_REQUIRED",
      httpStatus: 400,
      message: {
        "zh-CN": `${params.authMethod} 认证需要绑定密钥`,
        "en-US": `${params.authMethod} authentication requires authSecretId`,
      },
    });
  }
}

function resolvePeerCertificateFingerprint256(req: unknown): string | null {
  const socket = (req as { raw?: { socket?: { getPeerCertificate?: (detailed?: boolean) => { fingerprint256?: string } } } } | undefined)?.raw?.socket;
  const cert = socket?.getPeerCertificate?.(true);
  const fingerprint = String(cert?.fingerprint256 ?? "").trim();
  return fingerprint || null;
}

export const governanceFederationRoutes: FastifyPluginAsync = async (app) => {
  // ─── 获取联邦网关状态 ────────────────────────────────────────────────
  app.get("/governance/federation/status", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "federation.status.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const status = getFederationGatewayStatus();
    const nodes = await listFederationNodes({ pool: app.db, tenantId: subject.tenantId, limit: 100 });
    const activeNodes = nodes.filter((n) => n.status === "active").length;

    req.ctx.audit!.outputDigest = { enabled: status.enabled, mode: status.mode, nodeCount: nodes.length, activeNodes };
    return { status, nodeCount: nodes.length, activeNodes };
  });

  // ─── 列出联邦节点 ────────────────────────────────────────────────────
  app.get("/governance/federation/nodes", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "federation.node.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const q = req.query as Record<string, unknown>;
    const limit = z.coerce.number().int().min(1).max(200).optional().parse(q?.limit) ?? 50;
    const offset = z.coerce.number().int().min(0).optional().parse(q?.offset) ?? 0;
    const status = z.enum(["pending", "active", "suspended", "revoked"]).optional().parse(q?.status);

    const nodes = await listFederationNodes({ pool: app.db, tenantId: subject.tenantId, status, limit, offset });
    req.ctx.audit!.outputDigest = { count: nodes.length };
    return { nodes };
  });

  // ─── 获取单个联邦节点 ────────────────────────────────────────────────
  app.get("/governance/federation/nodes/:nodeId", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "federation.node.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const node = await getFederationNode({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });
    if (!node) throw Errors.notFound("federation_node");

    const capabilities = await listNodeCapabilities({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });
    const logs = await listEnvelopeLogs({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId, limit: 20 });

    req.ctx.audit!.outputDigest = { nodeId: node.nodeId, status: node.status };
    return { node, capabilities, recentLogs: logs };
  });

  // ─── 创建联邦节点 ────────────────────────────────────────────────────
  app.post("/governance/federation/nodes", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        name: z.string().min(1).max(128),
        endpoint: z.string().url(),
        direction: z.enum(["inbound_only", "outbound_only", "bi"]).optional(),
        authMethod: z.enum(["bearer", "hmac", "mtls", "none"]).optional(),
        authSecretId: z.string().uuid().optional(),
        status: z.enum(["pending", "active", "suspended"]).optional(),
        trustLevel: z.enum(["untrusted", "trusted", "verified"]).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.node.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });
    ensureFederationAuthConfig({ authMethod: body.authMethod, authSecretId: body.authSecretId });

    const node = await createFederationNode({
      pool: app.db,
      tenantId: subject.tenantId,
      name: body.name,
      endpoint: body.endpoint,
      direction: body.direction,
      authMethod: body.authMethod,
      authSecretId: body.authSecretId,
      status: body.status,
      trustLevel: body.trustLevel,
      metadata: body.metadata,
    });

    req.ctx.audit!.outputDigest = { nodeId: node.nodeId, name: node.name, endpoint: node.endpoint };
    return { node };
  });

  // ─── 更新联邦节点 ────────────────────────────────────────────────────
  app.patch("/governance/federation/nodes/:nodeId", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(128).optional(),
        endpoint: z.string().url().optional(),
        direction: z.enum(["inbound_only", "outbound_only", "bi"]).optional(),
        authMethod: z.enum(["bearer", "hmac", "mtls", "none"]).optional(),
        authSecretId: z.string().uuid().nullable().optional(),
        status: z.enum(["pending", "active", "suspended", "revoked"]).optional(),
        trustLevel: z.enum(["untrusted", "trusted", "verified"]).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.node.update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });
    const current = await getFederationNode({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });
    if (!current) throw Errors.notFound("federation_node");
    ensureFederationAuthConfig({
      authMethod: body.authMethod,
      authSecretId: body.authSecretId !== undefined ? body.authSecretId : current.authSecretId,
    });

    const node = await updateFederationNode({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: params.nodeId,
      ...body,
    });
    if (!node) throw Errors.notFound("federation_node");

    req.ctx.audit!.inputDigest = { ...(req.ctx.audit!.inputDigest as Record<string,unknown> ?? {}), before: { name: current.name, endpoint: current.endpoint, direction: current.direction, status: current.status, trustLevel: current.trustLevel } };
    req.ctx.audit!.outputDigest = { nodeId: node.nodeId, status: node.status };
    return { node };
  });

  // ─── 删除联邦节点 ────────────────────────────────────────────────────
  app.delete("/governance/federation/nodes/:nodeId", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "governance", action: "federation.node.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const snapshot = await getFederationNode({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });
    if (!snapshot) throw Errors.notFound("federation_node");
    const capabilities = await listNodeCapabilities({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });

    const deleted = await deleteFederationNode({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });
    if (!deleted) throw Errors.notFound("federation_node");

    req.ctx.audit!.outputDigest = { nodeId: params.nodeId, deleted: true, snapshot: { name: snapshot.name, endpoint: snapshot.endpoint, direction: snapshot.direction, status: snapshot.status, trustLevel: snapshot.trustLevel, capabilities } };
    return { ok: true };
  });

  // ─── 测试联邦节点连通性 ────────────────────────────────────────────
  app.post("/governance/federation/nodes/:nodeId/test", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);
    const body = z.object({ authToken: z.string().optional(), sourceNodeId: z.string().uuid().optional() }).parse(req.body ?? {});

    setAuditContext(req, { resourceType: "governance", action: "federation.node.test" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const result = await testFederationNode({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: params.nodeId,
      masterKey: app.cfg.secrets.masterKey,
      sourceNodeId: body.sourceNodeId,
      authToken: body.authToken,
    });

    req.ctx.audit!.outputDigest = { nodeId: params.nodeId, ok: result.ok, latencyMs: result.latencyMs };
    return result;
  });

  // ─── 更新节点心跳 ────────────────────────────────────────────────────
  app.post("/governance/federation/nodes/:nodeId/heartbeat", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "governance", action: "federation.node.heartbeat" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    await updateHeartbeat({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });

    req.ctx.audit!.outputDigest = { nodeId: params.nodeId };
    return { ok: true };
  });

  // ─── 获取节点能力列表 ────────────────────────────────────────────────
  app.get("/governance/federation/nodes/:nodeId/capabilities", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "governance", action: "federation.capability.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const capabilities = await listNodeCapabilities({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });

    req.ctx.audit!.outputDigest = { nodeId: params.nodeId, count: capabilities.length };
    return { capabilities };
  });

  // ─── 添加/更新节点能力 ────────────────────────────────────────────────
  app.post("/governance/federation/nodes/:nodeId/capabilities", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        capabilityType: z.enum(["tool", "skill", "schema", "workflow"]),
        capabilityRef: z.string().min(1).max(256),
        version: z.string().max(64).optional(),
        status: z.enum(["available", "deprecated", "revoked"]).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.capability.upsert" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const capability = await upsertNodeCapability({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: params.nodeId,
      capabilityType: body.capabilityType,
      capabilityRef: body.capabilityRef,
      version: body.version,
      status: body.status,
      metadata: body.metadata,
    });

    req.ctx.audit!.outputDigest = { nodeId: params.nodeId, capabilityId: capability.capabilityId };
    return { capability };
  });

  // ─── 查看通信日志 ────────────────────────────────────────────────────
  app.get("/governance/federation/logs", async (req) => {
    const subject = req.ctx.subject!;
    const q = req.query as Record<string, unknown>;
    const nodeId = z.string().uuid().optional().parse(q?.nodeId);
    const correlationId = z.string().optional().parse(q?.correlationId);
    const limit = z.coerce.number().int().min(1).max(200).optional().parse(q?.limit) ?? 50;

    setAuditContext(req, { resourceType: "governance", action: "federation.log.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const logs = await listEnvelopeLogs({ pool: app.db, tenantId: subject.tenantId, nodeId, correlationId, limit });

    req.ctx.audit!.outputDigest = { count: logs.length };
    return { logs };
  });

  // ─── 联邦入站端点（供远程节点调用） ────────────────────────────────
  app.post("/federation/inbound", async (req, reply) => {
    const tenantId = (req.headers["x-federation-tenant"] as string | undefined) ?? "tenant_dev";
    const sourceNodeId = (req.headers["x-federation-source-node"] as string | undefined);

    setAuditContext(req, { resourceType: "federation", action: "inbound.receive" });

    if (!sourceNodeId) {
      return reply.status(400).send({ errorCode: "MISSING_SOURCE_NODE", message: { "zh-CN": "缺少来源节点标识", "en-US": "Missing source node identifier" } });
    }

    const bodySchema = z.object({
      format: z.literal("federation.envelope.v1"),
      tenantId: z.string(),
      collabRunId: z.string(),
      correlationId: z.string(),
      fromRole: z.string(),
      toRole: z.string().nullable().optional(),
      broadcast: z.boolean().optional(),
      kind: z.enum(["proposal", "question", "answer", "observation", "command"]),
      payloadDigest: z.any(),
    });

    const parseResult = bodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({ errorCode: "INVALID_ENVELOPE", message: { "zh-CN": "信封格式无效", "en-US": "Invalid envelope format" } });
    }

    const envelope = parseResult.data as FederationEnvelopeV1;
    if (envelope.tenantId !== tenantId) {
      return reply.status(400).send({ errorCode: "TENANT_MISMATCH", message: { "zh-CN": "租户头与信封不一致", "en-US": "Tenant header does not match envelope" } });
    }
    const result = await handleInboundFederationEnvelope({
      pool: app.db,
      tenantId,
      sourceNodeId,
      envelope,
      masterKey: app.cfg.secrets.masterKey,
      headers: req.headers,
      peerCertificateFingerprint256: resolvePeerCertificateFingerprint256(req),
      clientIp: req.ip,
      userAgent: req.headers["user-agent"] as string | undefined,
    });

    if (!result.accepted) {
      return reply.status(403).send({ errorCode: "REJECTED", message: { "zh-CN": `拒绝: ${result.reason}`, "en-US": `Rejected: ${result.reason}` } });
    }

    return { ok: true };
  });

  // ─── 联邦 ping 端点（用于连通性测试） ────────────────────────────────
  app.get("/federation/ping", async (req) => {
    const tenantId = (req.headers["x-federation-tenant"] as string | undefined) ?? "tenant_dev";
    const status = getFederationGatewayStatus();

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      tenantId,
      federation: {
        enabled: status.enabled,
        mode: status.mode,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Permission Grants - 节点级权限授权
  // ═══════════════════════════════════════════════════════════════════════════

  // 列出权限授权
  app.get("/governance/federation/permission-grants", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "federation.permission.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const q = req.query as Record<string, unknown>;
    const nodeId = z.string().uuid().optional().parse(q?.nodeId);
    const capabilityId = z.string().uuid().optional().parse(q?.capabilityId);
    const activeOnly = z.coerce.boolean().optional().parse(q?.activeOnly) ?? true;
    const limit = z.coerce.number().int().min(1).max(200).optional().parse(q?.limit) ?? 100;

    const grants = await listPermissionGrants({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId,
      capabilityId,
      activeOnly,
      limit,
    });
    req.ctx.audit!.outputDigest = { count: grants.length };
    return { grants };
  });

  // 创建权限授权
  app.post("/governance/federation/permission-grants", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        nodeId: z.string().uuid(),
        capabilityId: z.string().uuid(),
        permissionType: z.enum(["read", "write", "forward", "audit", "invoke", "subscribe"]),
        expiresAt: z.string().datetime().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.permission.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const grant = await createPermissionGrant({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: body.nodeId,
      capabilityId: body.capabilityId,
      permissionType: body.permissionType as PermissionType,
      grantedBy: subject.subjectId,
      expiresAt: body.expiresAt,
      metadata: body.metadata,
    });

    await createAuditLog({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: body.nodeId,
      direction: "internal",
      operationType: "grant_change",
      subjectId: subject.subjectId,
      targetCapability: body.capabilityId,
      permissionType: body.permissionType,
      decision: "allowed",
      decisionReason: "permission_granted",
    });

    req.ctx.audit!.outputDigest = { grantId: grant.grantId };
    return { grant };
  });

  // 撤销权限授权
  app.post("/governance/federation/permission-grants/:grantId/revoke", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ grantId: z.string().uuid() }).parse(req.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});

    setAuditContext(req, { resourceType: "governance", action: "federation.permission.revoke" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const ok = await revokePermissionGrant({
      pool: app.db,
      tenantId: subject.tenantId,
      grantId: params.grantId,
      reason: body.reason,
    });

    if (!ok) throw Errors.notFound("permission_grant");
    req.ctx.audit!.outputDigest = { grantId: params.grantId, revoked: true };
    return { ok: true };
  });

  // 检查权限
  app.post("/governance/federation/check-permission", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        nodeId: z.string().uuid(),
        capabilityId: z.string().uuid(),
        permissionType: z.enum(["read", "write", "forward", "audit", "invoke", "subscribe"]),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.permission.check" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const result = await checkPermission({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: body.nodeId,
      capabilityId: body.capabilityId,
      permissionType: body.permissionType as PermissionType,
    });

    req.ctx.audit!.outputDigest = { allowed: result.allowed };
    return result;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // User Grants - 用户级跨域授权
  // ═══════════════════════════════════════════════════════════════════════════

  // 列出用户授权
  app.get("/governance/federation/user-grants", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "federation.user-grant.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const q = req.query as Record<string, unknown>;
    const grantorSubject = z.string().optional().parse(q?.grantorSubject);
    const granteeNodeId = z.string().uuid().optional().parse(q?.granteeNodeId);
    const granteeSubject = z.string().optional().parse(q?.granteeSubject);
    const activeOnly = z.coerce.boolean().optional().parse(q?.activeOnly) ?? true;
    const limit = z.coerce.number().int().min(1).max(200).optional().parse(q?.limit) ?? 100;

    const grants = await listUserGrants({
      pool: app.db,
      tenantId: subject.tenantId,
      grantorSubject,
      granteeNodeId,
      granteeSubject,
      activeOnly,
      limit,
    });
    req.ctx.audit!.outputDigest = { count: grants.length };
    return { grants };
  });

  // 创建用户授权
  app.post("/governance/federation/user-grants", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        granteeNodeId: z.string().uuid(),
        granteeSubject: z.string().min(1).max(256),
        capabilityId: z.string().uuid().optional(),
        permissionType: z.enum(["read", "write", "forward", "audit"]),
        scope: z.enum(["specific", "all_capabilities"]).optional(),
        expiresAt: z.string().datetime().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.user-grant.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const grant = await createUserGrant({
      pool: app.db,
      tenantId: subject.tenantId,
      grantorSubject: subject.subjectId,
      granteeNodeId: body.granteeNodeId,
      granteeSubject: body.granteeSubject,
      capabilityId: body.capabilityId,
      permissionType: body.permissionType as PermissionType,
      scope: body.scope,
      expiresAt: body.expiresAt,
      metadata: body.metadata,
    });

    req.ctx.audit!.outputDigest = { userGrantId: grant.userGrantId };
    return { grant };
  });

  // 撤销用户授权
  app.post("/governance/federation/user-grants/:userGrantId/revoke", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ userGrantId: z.string().uuid() }).parse(req.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});

    setAuditContext(req, { resourceType: "governance", action: "federation.user-grant.revoke" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const ok = await revokeUserGrant({
      pool: app.db,
      tenantId: subject.tenantId,
      userGrantId: params.userGrantId,
      reason: body.reason,
    });

    if (!ok) throw Errors.notFound("user_grant");
    req.ctx.audit!.outputDigest = { userGrantId: params.userGrantId, revoked: true };
    return { ok: true };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Content Policies - 内容策略
  // ═══════════════════════════════════════════════════════════════════════════

  // 列出内容策略
  app.get("/governance/federation/content-policies", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "federation.content-policy.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const q = req.query as Record<string, unknown>;
    const policyType = z.enum(["usage_restriction", "lifecycle", "redaction", "encryption"]).optional().parse(q?.policyType);
    const enabledOnly = z.coerce.boolean().optional().parse(q?.enabledOnly) ?? false;
    const limit = z.coerce.number().int().min(1).max(200).optional().parse(q?.limit) ?? 100;

    const policies = await listContentPolicies({
      pool: app.db,
      tenantId: subject.tenantId,
      policyType: policyType as ContentPolicyType | undefined,
      enabledOnly,
      limit,
    });
    req.ctx.audit!.outputDigest = { count: policies.length };
    return { policies };
  });

  // 获取单个内容策略
  app.get("/governance/federation/content-policies/:policyId", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "governance", action: "federation.content-policy.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const policy = await getContentPolicy({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId });
    if (!policy) throw Errors.notFound("content_policy");

    req.ctx.audit!.outputDigest = { policyId: policy.policyId };
    return { policy };
  });

  // 创建内容策略
  app.post("/governance/federation/content-policies", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        name: z.string().min(1).max(128),
        policyType: z.enum(["usage_restriction", "lifecycle", "redaction", "encryption"]),
        targetType: z.enum(["all", "capability", "node", "user"]).optional(),
        targetId: z.string().optional(),
        rules: z.record(z.string(), z.any()),
        priority: z.number().int().min(1).max(1000).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.content-policy.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const policy = await createContentPolicy({
      pool: app.db,
      tenantId: subject.tenantId,
      name: body.name,
      policyType: body.policyType as ContentPolicyType,
      targetType: body.targetType as any,
      targetId: body.targetId,
      rules: body.rules,
      priority: body.priority,
      enabled: body.enabled,
    });

    req.ctx.audit!.outputDigest = { policyId: policy.policyId };
    return { policy };
  });

  // 更新内容策略
  app.patch("/governance/federation/content-policies/:policyId", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(128).optional(),
        rules: z.record(z.string(), z.any()).optional(),
        priority: z.number().int().min(1).max(1000).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "federation.content-policy.update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const oldPolicy = await getContentPolicy({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId });
    if (!oldPolicy) throw Errors.notFound("content_policy");

    const policy = await updateContentPolicy({
      pool: app.db,
      tenantId: subject.tenantId,
      policyId: params.policyId,
      name: body.name,
      rules: body.rules,
      priority: body.priority,
      enabled: body.enabled,
    });

    if (!policy) throw Errors.notFound("content_policy");
    req.ctx.audit!.inputDigest = { ...(req.ctx.audit!.inputDigest as Record<string,unknown> ?? {}), before: oldPolicy };
    req.ctx.audit!.outputDigest = { policyId: policy.policyId };
    return { policy };
  });

  // 删除内容策略
  app.delete("/governance/federation/content-policies/:policyId", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "governance", action: "federation.content-policy.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const policySnapshot = await getContentPolicy({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId });
    if (!policySnapshot) throw Errors.notFound("content_policy");

    const ok = await deleteContentPolicy({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId });
    if (!ok) throw Errors.notFound("content_policy");

    req.ctx.audit!.outputDigest = { policyId: params.policyId, deleted: true, snapshot: { name: policySnapshot.name, rules: policySnapshot.rules, createdAt: policySnapshot.createdAt } };
    return { ok: true };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Audit Logs - 审计日志
  // ═══════════════════════════════════════════════════════════════════════════

  // 列出审计日志
  app.get("/governance/federation/audit-logs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "federation.audit.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_FEDERATION_READ });

    const q = req.query as Record<string, unknown>;
    const nodeId = z.string().uuid().optional().parse(q?.nodeId);
    const correlationId = z.string().optional().parse(q?.correlationId);
    const subjectId = z.string().optional().parse(q?.subjectId);
    const decision = z.enum(["allowed", "denied", "rate_limited", "policy_blocked"]).optional().parse(q?.decision);
    const limit = z.coerce.number().int().min(1).max(500).optional().parse(q?.limit) ?? 100;

    const logs = await listAuditLogs({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId,
      correlationId,
      subjectId,
      decision: decision as any,
      limit,
    });
    req.ctx.audit!.outputDigest = { count: logs.length };
    return { logs };
  });
};
