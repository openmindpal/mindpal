/**
 * Runner 协议统一类型定义
 *
 * 合并自：
 * - apps/runner/src/runnerProtocol.ts
 * - apps/worker/src/workflow/processor/runnerProtocol.ts
 *
 * 包含请求/响应类型、错误码、摘要计算、签名/验签全部函数。
 */
import crypto from "node:crypto";
import type { CapabilityEnvelopeV1 } from "./capabilityEnvelope";
import { sha256Hex, stableStringify } from "./cryptoUtils";

/* ================================================================== */
/*  Error Codes & Categories                                            */
/* ================================================================== */

export type RunnerErrorCode =
  | "TRUST_NOT_VERIFIED"
  | "RUNNER_CONTRACT_VIOLATION"
  | "RUNNER_UNAVAILABLE"
  | "REMOTE_RUNTIME_NOT_CONFIGURED"
  | "RESOURCE_EXHAUSTED"
  | "POLICY_VIOLATION"
  | "TIMEOUT"
  | "INTERNAL";

export type RunnerErrorCategory = "policy_violation" | "timeout" | "resource_exhausted" | "internal";

/* ================================================================== */
/*  Summary Types                                                        */
/* ================================================================== */

export type RunnerEgressSummaryV1 = {
  allowed: number;
  denied: number;
};

export type RunnerResourceUsageSummaryV1 = {
  latencyMs: number;
  outputBytes: number;
  egressRequests: number;
};

/* ================================================================== */
/*  Request / Response                                                    */
/* ================================================================== */

export type RunnerExecuteRequestV1 = {
  format: "runner.execute.v1";
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  scope: { tenantId: string; spaceId: string | null; subjectId: string | null };
  jobRef: { jobId: string; runId: string; stepId: string };
  toolRef: string;
  artifactRef: string | null;
  depsDigest: string | null;
  input: any;
  inputDigest: { sha256: string; sha256_8: string; bytes: number };
  capabilityEnvelope: CapabilityEnvelopeV1;
  policyDigests: { networkPolicySha256_8: string };
  signature?: { alg: "ed25519"; keyId: string; signedDigest: string; sigBase64: string };
  context?: { locale: string; apiBaseUrl?: string; authToken?: string };
};

export type RunnerExecuteResponseV1 = {
  format: "runner.execute.v1";
  requestId: string;
  status: "succeeded" | "failed";
  errorCode: RunnerErrorCode | null;
  errorCategory: RunnerErrorCategory | null;
  output: any;
  outputDigest: { sha256: string; sha256_8: string; bytes: number };
  egressSummary: RunnerEgressSummaryV1;
  egressEvents?: any[];
  resourceUsageSummary: RunnerResourceUsageSummaryV1;
  runnerSignature?: { alg: "ed25519"; keyId: string; signedDigest: string; sigBase64: string };
};

/* ================================================================== */
/*  Digest Computation                                                    */
/* ================================================================== */

export function computeRunnerRequestBodyDigestV1(req: RunnerExecuteRequestV1) {
  const body = {
    format: req.format,
    requestId: req.requestId,
    issuedAt: req.issuedAt,
    expiresAt: req.expiresAt,
    scope: req.scope,
    jobRef: req.jobRef,
    toolRef: req.toolRef,
    artifactRef: req.artifactRef,
    depsDigest: req.depsDigest,
    inputDigest: req.inputDigest,
    capabilityEnvelope: req.capabilityEnvelope,
    policyDigests: req.policyDigests,
  };
  return `sha256:${sha256Hex(stableStringify(body))}`;
}

export function computeRunnerResponseBodyDigestV1(res: RunnerExecuteResponseV1) {
  const body = {
    format: res.format,
    requestId: res.requestId,
    status: res.status,
    errorCode: res.errorCode,
    errorCategory: res.errorCategory,
    outputDigest: res.outputDigest,
    egressSummary: res.egressSummary,
    resourceUsageSummary: res.resourceUsageSummary,
  };
  return `sha256:${sha256Hex(stableStringify(body))}`;
}

/* ================================================================== */
/*  Signature — Request                                                   */
/* ================================================================== */

/** 签名 Runner 请求（Worker 侧使用） */
export function signRunnerRequestV1(params: { req: RunnerExecuteRequestV1; keyId: string; privateKeyPem: string }) {
  const signedDigest = computeRunnerRequestBodyDigestV1(params.req);
  const msg = `mindpal:runner:execute:${signedDigest}`;
  const sig = crypto.sign(null, Buffer.from(msg, "utf8"), crypto.createPrivateKey(params.privateKeyPem));
  return { alg: "ed25519" as const, keyId: params.keyId, signedDigest, sigBase64: sig.toString("base64") };
}

/** 验证 Runner 请求签名（Runner 侧使用） */
export function verifyRunnerRequestSignatureV1(params: {
  req: RunnerExecuteRequestV1;
  trustedKeys: Map<string, crypto.KeyObject>;
}): { ok: true } | { ok: false; error: string } {
  const sig = params.req.signature;
  if (!sig) return { ok: false, error: "missing_signature" };
  if (sig.alg !== "ed25519") return { ok: false, error: "unsupported_alg" };
  const pub = params.trustedKeys.get(sig.keyId);
  if (!pub) return { ok: false, error: "unknown_key" };
  const expected = computeRunnerRequestBodyDigestV1(params.req);
  if (sig.signedDigest !== expected) return { ok: false, error: "signed_digest_mismatch" };
  const msg = `mindpal:runner:execute:${expected}`;
  const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(sig.sigBase64, "base64"));
  if (!ok) return { ok: false, error: "bad_signature" };
  return { ok: true };
}

/* ================================================================== */
/*  Signature — Response                                                  */
/* ================================================================== */

/** 签名 Runner 响应（Runner 侧使用） */
export function signRunnerResponseV1(params: { res: RunnerExecuteResponseV1; keyId: string; privateKeyPem: string }) {
  const signedDigest = computeRunnerResponseBodyDigestV1(params.res);
  const msg = `mindpal:runner:result:${signedDigest}`;
  const sig = crypto.sign(null, Buffer.from(msg, "utf8"), crypto.createPrivateKey(params.privateKeyPem));
  return { alg: "ed25519" as const, keyId: params.keyId, signedDigest, sigBase64: sig.toString("base64") };
}

/** 验证 Runner 响应签名（Worker 侧使用） */
export function verifyRunnerResponseSignatureV1(params: {
  res: RunnerExecuteResponseV1;
  trustedKeys: Map<string, crypto.KeyObject>;
}): { ok: true } | { ok: false; error: string } {
  const sig = params.res.runnerSignature;
  if (!sig) return { ok: false, error: "missing_runner_signature" };
  if (sig.alg !== "ed25519") return { ok: false, error: "unsupported_alg" };
  const pub = params.trustedKeys.get(sig.keyId);
  if (!pub) return { ok: false, error: "unknown_key" };
  const expected = computeRunnerResponseBodyDigestV1(params.res);
  if (sig.signedDigest !== expected) return { ok: false, error: "signed_digest_mismatch" };
  const msg = `mindpal:runner:result:${expected}`;
  const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(sig.sigBase64, "base64"));
  if (!ok) return { ok: false, error: "bad_signature" };
  return { ok: true };
}

/* ================================================================== */
/*  Key Loading Utilities                                                 */
/* ================================================================== */

/** 从环境变量加载 Runner 信任的 Worker 公钥集合 */
export function loadTrustedWorkerKeysFromEnv(): Map<string, crypto.KeyObject> {
  const out = new Map<string, crypto.KeyObject>();
  const raw = String(process.env.RUNNER_TRUSTED_WORKER_KEYS_JSON ?? "").trim();
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries<any>(obj)) {
          const keyId = String(k ?? "").trim();
          const pem = typeof v === "string" ? v.trim() : "";
          if (!keyId || !pem) continue;
          try {
            out.set(keyId, crypto.createPublicKey(pem));
          } catch {}
        }
      }
    } catch {}
  }
  const keyId = String(process.env.RUNNER_TRUSTED_WORKER_KEY_ID ?? "").trim();
  const pem = String(process.env.RUNNER_TRUSTED_WORKER_PUBLIC_KEY_PEM ?? "").trim();
  if (keyId && pem) {
    try {
      out.set(keyId, crypto.createPublicKey(pem));
    } catch {}
  }
  return out;
}
