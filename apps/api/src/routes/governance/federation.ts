import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
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
} from "../../modules/federation/federationRepo";
import {
  getFederationGatewayStatus,
  testFederationNode,
  handleInboundFederationEnvelope,
  type FederationEnvelopeV1,
} from "../../skills/collab-runtime/modules/federationGateway";

export const governanceFederationRoutes: FastifyPluginAsync = async (app) => {
  // ─── 获取联邦网关状态 ────────────────────────────────────────────────
  app.get("/governance/federation/status", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "federation.status.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.read" });

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
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.read" });

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
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.read" });

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

    const node = await updateFederationNode({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: params.nodeId,
      ...body,
    });
    if (!node) throw Errors.notFound("federation_node");

    req.ctx.audit!.outputDigest = { nodeId: node.nodeId, status: node.status };
    return { node };
  });

  // ─── 删除联邦节点 ────────────────────────────────────────────────────
  app.delete("/governance/federation/nodes/:nodeId", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "governance", action: "federation.node.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.write" });

    const deleted = await deleteFederationNode({ pool: app.db, tenantId: subject.tenantId, nodeId: params.nodeId });
    if (!deleted) throw Errors.notFound("federation_node");

    req.ctx.audit!.outputDigest = { nodeId: params.nodeId, deleted: true };
    return { ok: true };
  });

  // ─── 测试联邦节点连通性 ────────────────────────────────────────────
  app.post("/governance/federation/nodes/:nodeId/test", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ nodeId: z.string().uuid() }).parse(req.params);
    const body = z.object({ authToken: z.string().optional() }).parse(req.body ?? {});

    setAuditContext(req, { resourceType: "governance", action: "federation.node.test" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.read" });

    const result = await testFederationNode({
      pool: app.db,
      tenantId: subject.tenantId,
      nodeId: params.nodeId,
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
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.read" });

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
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "federation.read" });

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
    const result = await handleInboundFederationEnvelope({
      pool: app.db,
      tenantId,
      sourceNodeId,
      envelope,
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
};
