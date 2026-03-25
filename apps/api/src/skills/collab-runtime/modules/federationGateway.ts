import type { Pool } from "pg";
import {
  type FederationNodeRow,
  getFederationNode,
  listFederationNodes,
  createEnvelopeLog,
} from "../../../modules/federation/federationRepo";

export type FederationGatewayStatus = {
  enabled: boolean;
  mode: "disabled" | "outbound_only" | "inbound_only" | "bi";
  provider: string | null;
};

export type FederationEnvelopeV1 = {
  format: "federation.envelope.v1";
  tenantId: string;
  collabRunId: string;
  correlationId: string;
  fromRole: string;
  toRole?: string | null;
  broadcast?: boolean;
  kind: "proposal" | "question" | "answer" | "observation" | "command";
  payloadDigest: any;
};

export type FederationDeliveryResult = {
  delivered: boolean;
  reason?: string;
  nodeId?: string;
  latencyMs?: number;
};

export function getFederationGatewayStatus(): FederationGatewayStatus {
  const raw = String(process.env.FEDERATION_MODE ?? "disabled").trim().toLowerCase();
  const mode = raw === "bi" || raw === "outbound_only" || raw === "inbound_only" ? (raw as any) : "disabled";
  const enabled = mode !== "disabled";
  const provider = enabled ? String(process.env.FEDERATION_PROVIDER ?? "").trim() || null : null;
  return { enabled, mode, provider };
}

/**
 * 向指定联邦节点发送消息信封
 */
export async function sendToFederationNode(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  envelope: FederationEnvelopeV1;
  authToken?: string;
}): Promise<FederationDeliveryResult> {
  const st = getFederationGatewayStatus();
  if (!st.enabled) return { delivered: false, reason: "federation_disabled" };
  if (st.mode === "inbound_only") return { delivered: false, reason: "outbound_disabled" };

  const node = await getFederationNode({ pool: params.pool, tenantId: params.tenantId, nodeId: params.nodeId });
  if (!node) return { delivered: false, reason: "node_not_found" };
  if (node.status !== "active") return { delivered: false, reason: "node_not_active" };
  if (node.direction === "inbound_only") return { delivered: false, reason: "node_outbound_disabled" };

  const startMs = Date.now();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Federation-Tenant": params.tenantId,
      "X-Federation-Correlation": params.envelope.correlationId,
    };

    // 根据认证方式添加认证头
    if (node.authMethod === "bearer" && params.authToken) {
      headers["Authorization"] = `Bearer ${params.authToken}`;
    }

    const res = await fetch(`${node.endpoint}/federation/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify(params.envelope),
      signal: AbortSignal.timeout(30_000),
    });

    const latencyMs = Date.now() - startMs;
    const delivered = res.ok;

    // 记录日志
    await createEnvelopeLog({
      pool: params.pool,
      tenantId: params.tenantId,
      nodeId: params.nodeId,
      direction: "outbound",
      envelopeType: params.envelope.kind,
      correlationId: params.envelope.correlationId,
      payloadDigest: { collabRunId: params.envelope.collabRunId, fromRole: params.envelope.fromRole },
      status: delivered ? "delivered" : "failed",
      errorMessage: delivered ? null : `HTTP ${res.status}`,
      latencyMs,
    });

    return { delivered, nodeId: node.nodeId, latencyMs, reason: delivered ? undefined : `http_${res.status}` };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const errorMessage = err instanceof Error ? err.message : String(err);

    await createEnvelopeLog({
      pool: params.pool,
      tenantId: params.tenantId,
      nodeId: params.nodeId,
      direction: "outbound",
      envelopeType: params.envelope.kind,
      correlationId: params.envelope.correlationId,
      payloadDigest: { collabRunId: params.envelope.collabRunId, fromRole: params.envelope.fromRole },
      status: "failed",
      errorMessage,
      latencyMs,
    });

    return { delivered: false, nodeId: node.nodeId, latencyMs, reason: errorMessage };
  }
}

/**
 * 广播消息到所有活跃的联邦节点
 */
export async function broadcastToFederationNodes(params: {
  pool: Pool;
  tenantId: string;
  envelope: FederationEnvelopeV1;
  authTokenResolver?: (node: FederationNodeRow) => Promise<string | undefined>;
}): Promise<{ results: FederationDeliveryResult[]; successCount: number; failCount: number }> {
  const st = getFederationGatewayStatus();
  if (!st.enabled) return { results: [], successCount: 0, failCount: 0 };
  if (st.mode === "inbound_only") return { results: [], successCount: 0, failCount: 0 };

  const nodes = await listFederationNodes({ pool: params.pool, tenantId: params.tenantId, status: "active" });
  const outboundNodes = nodes.filter((n) => n.direction !== "inbound_only");

  const results: FederationDeliveryResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const node of outboundNodes) {
    const authToken = params.authTokenResolver ? await params.authTokenResolver(node) : undefined;
    const result = await sendToFederationNode({
      pool: params.pool,
      tenantId: params.tenantId,
      nodeId: node.nodeId,
      envelope: params.envelope,
      authToken,
    });
    results.push(result);
    if (result.delivered) successCount++;
    else failCount++;
  }

  return { results, successCount, failCount };
}

/**
 * 处理入站联邦消息
 */
export async function handleInboundFederationEnvelope(params: {
  pool: Pool;
  tenantId: string;
  sourceNodeId: string;
  envelope: FederationEnvelopeV1;
}): Promise<{ accepted: boolean; reason?: string }> {
  const st = getFederationGatewayStatus();
  if (!st.enabled) return { accepted: false, reason: "federation_disabled" };
  if (st.mode === "outbound_only") return { accepted: false, reason: "inbound_disabled" };

  const node = await getFederationNode({ pool: params.pool, tenantId: params.tenantId, nodeId: params.sourceNodeId });
  if (!node) return { accepted: false, reason: "node_not_found" };
  if (node.status !== "active") return { accepted: false, reason: "node_not_active" };
  if (node.direction === "outbound_only") return { accepted: false, reason: "node_inbound_disabled" };
  if (node.trustLevel === "untrusted") return { accepted: false, reason: "node_untrusted" };

  // 记录入站日志
  await createEnvelopeLog({
    pool: params.pool,
    tenantId: params.tenantId,
    nodeId: params.sourceNodeId,
    direction: "inbound",
    envelopeType: params.envelope.kind,
    correlationId: params.envelope.correlationId,
    payloadDigest: { collabRunId: params.envelope.collabRunId, fromRole: params.envelope.fromRole },
    status: "delivered",
  });

  // TODO: 实际处理入站消息的业务逻辑
  return { accepted: true };
}

/**
 * 测试联邦节点连通性
 */
export async function testFederationNode(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  authToken?: string;
}): Promise<{ ok: boolean; latencyMs: number; error?: string; remoteInfo?: unknown }> {
  const node = await getFederationNode({ pool: params.pool, tenantId: params.tenantId, nodeId: params.nodeId });
  if (!node) return { ok: false, latencyMs: 0, error: "node_not_found" };

  const startMs = Date.now();
  try {
    const headers: Record<string, string> = {
      "X-Federation-Tenant": params.tenantId,
    };
    if (node.authMethod === "bearer" && params.authToken) {
      headers["Authorization"] = `Bearer ${params.authToken}`;
    }

    const res = await fetch(`${node.endpoint}/federation/ping`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const latencyMs = Date.now() - startMs;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };

    const json = await res.json().catch(() => null);
    return { ok: true, latencyMs, remoteInfo: json };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    return { ok: false, latencyMs, error: err instanceof Error ? err.message : String(err) };
  }
}

// 保留旧的兼容接口
export async function emitFederationEnvelope(_env: FederationEnvelopeV1): Promise<{ delivered: boolean; reason?: string }> {
  const st = getFederationGatewayStatus();
  if (!st.enabled) return { delivered: false, reason: "disabled" };
  // 注意：这个旧接口不再推荐使用，请使用 sendToFederationNode 或 broadcastToFederationNodes
  return { delivered: false, reason: "use_new_api" };
}
