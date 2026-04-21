import crypto from "node:crypto";
import https from "node:https";
import type { Pool } from "pg";
import {
  type FederationNodeRow,
  getFederationNode,
  listFederationNodes,
  createEnvelopeLog,
  createAuditLog,
} from "../../../modules/federation/federationRepo";
import { decryptSecretPayload } from "../../../modules/secrets/envelope";
import { getSecretRecordEncryptedPayload } from "../../../modules/secrets/secretRepo";
import { getCollabRun } from "./collabRepo";
import { appendCollabEnvelope } from "./collabEnvelopeRepo";
import { appendCollabRunEvent } from "./collabEventRepo";
import { getOrCreateBreaker, StructuredLogger, canonicalize, canonicalStringify } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:federationGateway" });
import { safeCompare, verifyWebhookSignature } from "../../../lib/webhookVerification";

/** 联邦出站熔断器默认参数 */
const FED_BREAKER_DEFAULTS = {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 1,
  onStateChange: (e: { name: string; from: string; to: string; consecutiveFailures: number }) => {
    _logger.warn("circuit-breaker state change", { name: e.name, from: e.from, to: e.to, consecutiveFailures: e.consecutiveFailures });
  },
} as const;

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

type FederationAuthSecretPayload = {
  bearerToken?: string;
  token?: string;
  sharedSecret?: string;
  secret?: string;
  hmacSecret?: string;
  signatureHeader?: string;
  timestampHeader?: string;
  toleranceSec?: number;
  clientCertPem?: string;
  certPem?: string;
  clientKeyPem?: string;
  keyPem?: string;
  caPem?: string;
  passphrase?: string;
  serverName?: string;
  rejectUnauthorized?: boolean;
  certificateFingerprint256?: string;
  fingerprint256?: string;
  fingerprints256?: string[];
  forwardedFingerprintHeader?: string;
};

type DecryptedFederationSecret = {
  payload: FederationAuthSecretPayload;
  secretId: string;
};

type InboundAuthValidationParams = {
  pool: Pool;
  tenantId: string;
  node: FederationNodeRow;
  masterKey?: string | null;
  headers?: Record<string, string | string[] | undefined>;
  envelope: FederationEnvelopeV1;
  peerCertificateFingerprint256?: string | null;
};

type InboundAuthValidationResult = {
  valid: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
};

function masterKey(explicit?: string | null) {
  return String(explicit ?? process.env.API_MASTER_KEY ?? "dev-master-key-change-me");
}

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "");
}

function normalizeFingerprint(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");
}

function localFederationNodeId(explicit?: string | null): string | null {
  const value = String(explicit ?? process.env.FEDERATION_NODE_ID ?? process.env.FEDERATION_SOURCE_NODE_ID ?? "").trim();
  return value || null;
}

function getHmacTimestampSec() {
  return String(Math.floor(Date.now() / 1000));
}

function buildFederationEnvelopeAuthBody(envelope: FederationEnvelopeV1): string {
  return canonicalStringify(envelope);
}

export function buildFederationHmacSignature(secret: string, envelope: FederationEnvelopeV1, timestampSec: string): string {
  const rawBody = buildFederationEnvelopeAuthBody(envelope);
  return crypto.createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`, "utf8").digest("hex");
}

export function matchesFederationMtlsFingerprint(params: {
  allowedFingerprints: string[];
  presentedFingerprint?: string | null;
}): boolean {
  const presented = normalizeFingerprint(params.presentedFingerprint);
  if (!presented) return false;
  for (const raw of params.allowedFingerprints) {
    const candidate = normalizeFingerprint(raw);
    if (candidate && candidate.length === presented.length && safeCompare(candidate, presented)) {
      return true;
    }
  }
  return false;
}

async function loadFederationAuthSecret(params: {
  pool: Pool;
  tenantId: string;
  node: FederationNodeRow;
  masterKey?: string | null;
}): Promise<DecryptedFederationSecret | null> {
  if (!params.node.authSecretId) return null;
  const secret = await getSecretRecordEncryptedPayload(params.pool, params.tenantId, params.node.authSecretId);
  if (!secret || secret.secret.status !== "active") return null;
  const decrypted = await decryptSecretPayload({
    pool: params.pool,
    tenantId: params.tenantId,
    masterKey: masterKey(params.masterKey),
    scopeType: secret.secret.scopeType,
    scopeId: secret.secret.scopeId,
    keyVersion: secret.secret.keyVersion,
    encFormat: secret.secret.encFormat,
    encryptedPayload: secret.encryptedPayload,
  });
  if (!decrypted || typeof decrypted !== "object") return null;
  return { payload: decrypted as FederationAuthSecretPayload, secretId: secret.secret.id };
}

function getBearerTokenFromSecret(payload: FederationAuthSecretPayload): string | null {
  const token = String(payload.bearerToken ?? payload.token ?? "").trim();
  return token || null;
}

function getHmacSecretFromSecret(payload: FederationAuthSecretPayload): string | null {
  const secret = String(payload.hmacSecret ?? payload.sharedSecret ?? payload.secret ?? "").trim();
  return secret || null;
}

function getAllowedMtlsFingerprints(payload: FederationAuthSecretPayload): string[] {
  const raw = [
    payload.certificateFingerprint256,
    payload.fingerprint256,
    ...(Array.isArray(payload.fingerprints256) ? payload.fingerprints256 : []),
  ];
  return raw.map((x) => normalizeFingerprint(String(x ?? ""))).filter(Boolean);
}

function resolvePresentedMtlsFingerprint(params: {
  headers?: Record<string, string | string[] | undefined>;
  payload?: FederationAuthSecretPayload | null;
  peerCertificateFingerprint256?: string | null;
}): string | null {
  const preferredHeader = String(params.payload?.forwardedFingerprintHeader ?? "").trim().toLowerCase();
  const headerNames = [
    preferredHeader,
    "x-forwarded-client-cert-sha256",
    "x-client-cert-sha256",
    "x-mtls-client-cert-sha256",
  ].filter(Boolean);
  for (const name of headerNames) {
    const value = normalizeFingerprint(firstHeaderValue(params.headers?.[name]));
    if (value) return value;
  }
  return normalizeFingerprint(params.peerCertificateFingerprint256);
}

async function performFederationHttpRequest(params: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  mtls?: FederationAuthSecretPayload | null;
  timeoutMs: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  if (!params.mtls) {
    const res = await fetch(params.url, {
      method: params.method,
      headers: params.headers,
      body: params.body,
      signal: AbortSignal.timeout(params.timeoutMs),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

  const url = new URL(params.url);
  if (url.protocol !== "https:") {
    throw new Error("mtls_requires_https");
  }
  const cert = String(params.mtls.clientCertPem ?? params.mtls.certPem ?? "").trim();
  const key = String(params.mtls.clientKeyPem ?? params.mtls.keyPem ?? "").trim();
  if (!cert || !key) {
    throw new Error("mtls_secret_missing_cert_or_key");
  }
  const mtls = params.mtls;

  return await new Promise<{ ok: boolean; status: number; text: string }>((resolve, reject) => {
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: params.method,
      headers: params.headers,
      cert,
      key,
      ca: mtls.caPem ? String(mtls.caPem) : undefined,
      passphrase: mtls.passphrase ? String(mtls.passphrase) : undefined,
      servername: mtls.serverName ? String(mtls.serverName) : undefined,
      rejectUnauthorized: mtls.rejectUnauthorized !== false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          ok: Number(res.statusCode ?? 500) >= 200 && Number(res.statusCode ?? 500) < 300,
          status: Number(res.statusCode ?? 500),
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.setTimeout(params.timeoutMs, () => req.destroy(new Error(`timeout_after_${params.timeoutMs}ms`)));
    req.on("error", reject);
    if (params.body) req.write(params.body);
    req.end();
  });
}

async function buildOutboundFederationHeaders(params: {
  pool: Pool;
  tenantId: string;
  node: FederationNodeRow;
  envelope: FederationEnvelopeV1;
  sourceNodeId: string;
  masterKey?: string | null;
  authToken?: string;
}): Promise<{ headers: Record<string, string>; mtlsSecret: FederationAuthSecretPayload | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Federation-Tenant": params.tenantId,
    "X-Federation-Correlation": params.envelope.correlationId,
    "X-Federation-Source-Node": params.sourceNodeId,
  };

  let mtlsSecret: FederationAuthSecretPayload | null = null;
  const decryptedSecret = await loadFederationAuthSecret({
    pool: params.pool,
    tenantId: params.tenantId,
    node: params.node,
    masterKey: params.masterKey,
  });
  const secretPayload = decryptedSecret?.payload ?? null;

  if (params.node.authMethod === "bearer") {
    const token = String(params.authToken ?? getBearerTokenFromSecret(secretPayload ?? {}) ?? "").trim();
    if (!token) throw new Error("bearer_secret_missing_token");
    headers.Authorization = `Bearer ${token}`;
  } else if (params.node.authMethod === "hmac") {
    const secret = getHmacSecretFromSecret(secretPayload ?? {});
    if (!secret) throw new Error("hmac_secret_missing_shared_secret");
    const timestampHeader = String(secretPayload?.timestampHeader ?? "x-federation-timestamp").trim();
    const signatureHeader = String(secretPayload?.signatureHeader ?? "x-federation-signature-256").trim();
    const ts = getHmacTimestampSec();
    headers[timestampHeader] = ts;
    headers[signatureHeader] = `sha256=${buildFederationHmacSignature(secret, params.envelope, ts)}`;
  } else if (params.node.authMethod === "mtls") {
    if (!secretPayload) throw new Error("mtls_secret_missing");
    mtlsSecret = secretPayload;
  }

  return { headers, mtlsSecret };
}

export async function validateInboundFederationAuth(params: InboundAuthValidationParams): Promise<InboundAuthValidationResult> {
  const headers = params.headers ?? {};
  if (params.node.authMethod === "none") return { valid: true };

  const secret = await loadFederationAuthSecret({
    pool: params.pool,
    tenantId: params.tenantId,
    node: params.node,
    masterKey: params.masterKey,
  });
  if (!secret) {
    return { valid: false, reason: "auth_secret_missing" };
  }

  if (params.node.authMethod === "bearer") {
    const expected = getBearerTokenFromSecret(secret.payload);
    const authHeader = firstHeaderValue(headers.authorization ?? headers.Authorization);
    const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!expected || !presented) return { valid: false, reason: "bearer_missing_token" };
    if (presented.length !== expected.length || !safeCompare(presented, expected)) {
      return { valid: false, reason: "bearer_invalid" };
    }
    return { valid: true };
  }

  if (params.node.authMethod === "hmac") {
    const sharedSecret = getHmacSecretFromSecret(secret.payload);
    if (!sharedSecret) return { valid: false, reason: "hmac_secret_missing_shared_secret" };
    const signatureHeader = String(secret.payload.signatureHeader ?? "x-federation-signature-256").trim();
    const timestampHeader = String(secret.payload.timestampHeader ?? "x-federation-timestamp").trim();
    const signature = firstHeaderValue(headers[signatureHeader.toLowerCase()] ?? headers[signatureHeader]);
    const timestamp = firstHeaderValue(headers[timestampHeader.toLowerCase()] ?? headers[timestampHeader]);
    const verify = verifyWebhookSignature({
      rawBody: buildFederationEnvelopeAuthBody(params.envelope),
      signature,
      timestamp,
      config: {
        secret: sharedSecret,
        signatureHeader,
        timestampHeader,
        toleranceSec: secret.payload.toleranceSec ?? 300,
        signatureScheme: "timestamp_body",
      },
    });
    if (!verify.valid) {
      return { valid: false, reason: `hmac_${verify.rejectReason ?? "invalid"}`, detail: verify.detail };
    }
    return { valid: true };
  }

  if (params.node.authMethod === "mtls") {
    const allowedFingerprints = getAllowedMtlsFingerprints(secret.payload);
    if (allowedFingerprints.length === 0) return { valid: false, reason: "mtls_secret_missing_fingerprint" };
    const presented = resolvePresentedMtlsFingerprint({
      headers,
      payload: secret.payload,
      peerCertificateFingerprint256: params.peerCertificateFingerprint256,
    });
    if (!presented) return { valid: false, reason: "mtls_peer_certificate_missing" };
    if (!matchesFederationMtlsFingerprint({ allowedFingerprints, presentedFingerprint: presented })) {
      return { valid: false, reason: "mtls_peer_certificate_mismatch", detail: { presentedFingerprint256: presented } };
    }
    return { valid: true, detail: { presentedFingerprint256: presented } };
  }

  return { valid: false, reason: "auth_method_unsupported" };
}

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
  masterKey?: string | null;
  sourceNodeId?: string | null;
  authToken?: string;
}): Promise<FederationDeliveryResult> {
  const st = getFederationGatewayStatus();
  if (!st.enabled) return { delivered: false, reason: "federation_disabled" };
  if (st.mode === "inbound_only") return { delivered: false, reason: "outbound_disabled" };

  const node = await getFederationNode({ pool: params.pool, tenantId: params.tenantId, nodeId: params.nodeId });
  if (!node) return { delivered: false, reason: "node_not_found" };
  if (node.status !== "active") return { delivered: false, reason: "node_not_active" };
  if (node.direction === "inbound_only") return { delivered: false, reason: "node_outbound_disabled" };

  // P0-02: 按 nodeId 维度熔断，OPEN 时快速失败
  const breaker = getOrCreateBreaker(`federation:${params.nodeId}`, FED_BREAKER_DEFAULTS);
  if (breaker.getState() === "open") {
    _logger.warn("circuit breaker OPEN, skipping outbound", { nodeId: params.nodeId });
    return { delivered: false, nodeId: node.nodeId, reason: "circuit_breaker_open" };
  }

  const sourceNodeId = localFederationNodeId(params.sourceNodeId);
  if (!sourceNodeId) {
    return { delivered: false, nodeId: node.nodeId, reason: "missing_source_node_id" };
  }

  const startMs = Date.now();
  try {
    const { headers, mtlsSecret } = await buildOutboundFederationHeaders({
      pool: params.pool,
      tenantId: params.tenantId,
      node,
      envelope: params.envelope,
      sourceNodeId,
      masterKey: params.masterKey,
      authToken: params.authToken,
    });
    const res = await performFederationHttpRequest({
      url: `${node.endpoint}/federation/inbound`,
      method: "POST",
      headers,
      body: JSON.stringify(params.envelope),
      mtls: mtlsSecret,
      timeoutMs: 30_000,
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
      payloadDigest: { collabRunId: params.envelope.collabRunId, fromRole: params.envelope.fromRole, sourceNodeId },
      status: delivered ? "delivered" : "failed",
      errorMessage: delivered ? null : `HTTP ${res.status}`,
      latencyMs,
    });

    if (delivered) {
      breaker.recordSuccess();
    } else {
      breaker.recordFailure();
    }

    return { delivered, nodeId: node.nodeId, latencyMs, reason: delivered ? undefined : `http_${res.status}` };
  } catch (err) {
    breaker.recordFailure();
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
  masterKey?: string | null;
  sourceNodeId?: string | null;
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
      masterKey: params.masterKey,
      sourceNodeId: params.sourceNodeId,
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
  masterKey?: string | null;
  headers?: Record<string, string | string[] | undefined>;
  peerCertificateFingerprint256?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
}): Promise<{ accepted: boolean; reason?: string }> {
  const st = getFederationGatewayStatus();
  if (!st.enabled) return { accepted: false, reason: "federation_disabled" };
  if (st.mode === "outbound_only") return { accepted: false, reason: "inbound_disabled" };

  const node = await getFederationNode({ pool: params.pool, tenantId: params.tenantId, nodeId: params.sourceNodeId });
  if (!node) return { accepted: false, reason: "node_not_found" };
  if (node.status !== "active") return { accepted: false, reason: "node_not_active" };
  if (node.direction === "outbound_only") return { accepted: false, reason: "node_inbound_disabled" };
  if (node.trustLevel === "untrusted") return { accepted: false, reason: "node_untrusted" };

  const auth = await validateInboundFederationAuth({
    pool: params.pool,
    tenantId: params.tenantId,
    node,
    masterKey: params.masterKey,
    headers: params.headers,
    envelope: params.envelope,
    peerCertificateFingerprint256: params.peerCertificateFingerprint256,
  });
  if (!auth.valid) {
    await createEnvelopeLog({
      pool: params.pool,
      tenantId: params.tenantId,
      nodeId: params.sourceNodeId,
      direction: "inbound",
      envelopeType: params.envelope.kind,
      correlationId: params.envelope.correlationId,
      payloadDigest: { collabRunId: params.envelope.collabRunId, fromRole: params.envelope.fromRole, authDetail: auth.detail ?? null },
      status: "rejected",
      errorMessage: auth.reason ?? "auth_invalid",
    }).catch(() => {});
    await createAuditLog({
      pool: params.pool,
      tenantId: params.tenantId,
      correlationId: params.envelope.correlationId,
      nodeId: params.sourceNodeId,
      direction: "inbound",
      operationType: "permission_check",
      decision: "denied",
      decisionReason: auth.reason ?? "auth_invalid",
      requestDigest: { authMethod: node.authMethod, envelopeKind: params.envelope.kind },
      responseDigest: auth.detail ?? null,
      clientIp: params.clientIp ?? null,
      userAgent: params.userAgent ?? null,
    }).catch(() => {});
    return { accepted: false, reason: auth.reason ?? "auth_invalid" };
  }

  // 记录入站日志
  await createEnvelopeLog({
    pool: params.pool,
    tenantId: params.tenantId,
    nodeId: params.sourceNodeId,
    direction: "inbound",
    envelopeType: params.envelope.kind,
    correlationId: params.envelope.correlationId,
    payloadDigest: { collabRunId: params.envelope.collabRunId, fromRole: params.envelope.fromRole, authMethod: node.authMethod, authDetail: auth.detail ?? null },
    status: "delivered",
  });

  // 查找关联的协作运行
  const collab = await getCollabRun({
    pool: params.pool,
    tenantId: params.tenantId,
    collabRunId: params.envelope.collabRunId,
  });

  if (!collab) {
    // 协作运行不存在，记录警告并返回
    _logger.warn("CollabRun not found", { collabRunId: params.envelope.collabRunId });
    return { accepted: false, reason: "collab_run_not_found" };
  }

  // 将入站消息追加到协作信封表
  const envelope = await appendCollabEnvelope({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: collab.spaceId,
    collabRunId: collab.collabRunId,
    taskId: collab.taskId,
    fromRole: `federation:${params.sourceNodeId}:${params.envelope.fromRole}`,
    toRole: params.envelope.toRole ?? null,
    broadcast: params.envelope.broadcast ?? false,
    kind: params.envelope.kind,
    correlationId: params.envelope.correlationId,
    policySnapshotRef: null,
    payloadDigest: params.envelope.payloadDigest,
    payloadRedacted: null,
  });

  // 记录协作运行事件
  await appendCollabRunEvent({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: collab.spaceId,
    collabRunId: collab.collabRunId,
    taskId: collab.taskId,
    type: "federation.envelope.received",
    actorRole: `federation:${params.sourceNodeId}`,
    policySnapshotRef: null,
    correlationId: params.envelope.correlationId,
    payloadDigest: {
      envelopeId: envelope.envelopeId,
      sourceNodeId: params.sourceNodeId,
      fromRole: params.envelope.fromRole,
      kind: params.envelope.kind,
      trustLevel: node.trustLevel,
    },
  });

  _logger.info("envelope accepted", { envelopeId: envelope.envelopeId, collabRunId: collab.collabRunId });
  return { accepted: true };
}

/**
 * 测试联邦节点连通性
 */
export async function testFederationNode(params: {
  pool: Pool;
  tenantId: string;
  nodeId: string;
  masterKey?: string | null;
  sourceNodeId?: string | null;
  authToken?: string;
}): Promise<{ ok: boolean; latencyMs: number; error?: string; remoteInfo?: unknown }> {
  const node = await getFederationNode({ pool: params.pool, tenantId: params.tenantId, nodeId: params.nodeId });
  if (!node) return { ok: false, latencyMs: 0, error: "node_not_found" };

  const sourceNodeId = localFederationNodeId(params.sourceNodeId);
  if (!sourceNodeId) return { ok: false, latencyMs: 0, error: "missing_source_node_id" };

  const startMs = Date.now();
  try {
    const probeEnvelope: FederationEnvelopeV1 = {
      format: "federation.envelope.v1",
      tenantId: params.tenantId,
      collabRunId: "federation-probe",
      correlationId: crypto.randomUUID(),
      fromRole: "probe",
      toRole: "probe",
      kind: "observation",
      payloadDigest: { probe: true },
    };
    const { headers, mtlsSecret } = await buildOutboundFederationHeaders({
      pool: params.pool,
      tenantId: params.tenantId,
      node,
      envelope: probeEnvelope,
      sourceNodeId,
      masterKey: params.masterKey,
      authToken: params.authToken,
    });
    const res = await performFederationHttpRequest({
      url: `${node.endpoint}/federation/ping`,
      method: "GET",
      headers,
      mtls: mtlsSecret,
      timeoutMs: 10_000,
    });

    const latencyMs = Date.now() - startMs;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };

    let json: unknown = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      json = null;
    }
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
