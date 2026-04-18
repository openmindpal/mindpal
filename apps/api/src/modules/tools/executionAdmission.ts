import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { checkCapabilityEnvelopeNotExceedV1, normalizeNetworkPolicy, normalizeLimits, validateCapabilityEnvelopeV1 } from "@openslin/shared";
import { getEffectiveToolNetworkPolicy } from "../governance/toolNetworkPolicyRepo";
import { sha256Hex } from "../../lib/digest";

/* ── P1-5: secretDomain 最小权限实装 ── */

/**
 * 获取有效的 connectorInstanceIds
 * - 基于 tenant/space 范围查询允许的 connector instances
 * - 可通过 requestedIds 限制请求范围
 */
export async function getEffectiveConnectorInstanceIds(params: {
  pool: any;
  tenantId: string;
  spaceId: string | null;
  requestedIds?: string[];
}): Promise<string[]> {
  // 查询当前 scope 下允许的 connector instances
  const scopeType = params.spaceId ? "space" : "tenant";
  const scopeId = params.spaceId ?? params.tenantId;

  const res = await params.pool.query(
    `
      SELECT id
      FROM connector_instances
      WHERE tenant_id = $1
        AND scope_type = $2
        AND scope_id = $3
        AND status = 'enabled'
      ORDER BY created_at DESC
      LIMIT 100
    `,
    [params.tenantId, scopeType, scopeId],
  );

  const allowedIds = new Set((res.rows as any[]).map((r) => String(r.id)));

  // 如果有请求的 IDs，取交集
  if (params.requestedIds && params.requestedIds.length > 0) {
    return params.requestedIds.filter((id) => allowedIds.has(id));
  }

  return Array.from(allowedIds);
}

export function networkPolicyDigest(allowedDomains: string[], rules: any[] | null) {
  const canon = allowedDomains.map((d) => d.trim()).filter(Boolean).sort();
  const rulesCanon = Array.isArray(rules) ? rules : [];
  return {
    allowedDomainsCount: canon.length,
    sha256_8: sha256Hex(canon.join("\n")).slice(0, 8),
    rulesCount: rulesCanon.length,
    rulesSha256_8: sha256Hex(JSON.stringify(rulesCanon)).slice(0, 8),
  };
}

export type ExecutionAdmissionResult =
  | {
      ok: true;
      envelope: CapabilityEnvelopeV1;
      limits: any;
      networkPolicy: any;
      networkPolicyDigest: ReturnType<typeof networkPolicyDigest>;
      effectiveEnvelope: CapabilityEnvelopeV1;
    }
  | { ok: false; reason: "missing" | "invalid" | "not_subset"; details?: any };

export async function admitToolExecution(params: {
  pool: any;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  toolRef: string;
  toolContract: { scope: string; resourceType: string; action: string; fieldRules: any; rowFilters: any };
  limits?: any;
  requestedCapabilityEnvelope?: any;
  requireRequestedEnvelope: boolean;
  /** P1-5: 请求的 connectorInstanceIds（可选），用于限制 secretDomain 范围 */
  requestedConnectorInstanceIds?: string[];
}) : Promise<ExecutionAdmissionResult> {
  const isPlainObject = (v: any) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

  const effPol = await getEffectiveToolNetworkPolicy({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId ?? undefined, toolRef: params.toolRef });
  const effAllowedDomains = effPol?.allowedDomains ?? [];
  const effRules = (effPol as any)?.rules ?? [];
  const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };

  let limits = params.limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) limits = {};
  const effLimits = normalizeLimits(limits);

  // P1-5: 获取有效的 connectorInstanceIds
  const effConnectorInstanceIds = await getEffectiveConnectorInstanceIds({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    requestedIds: params.requestedConnectorInstanceIds,
  });

  const effectiveEnvelope: CapabilityEnvelopeV1 = {
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      toolContract: {
        scope: params.toolContract.scope,
        resourceType: params.toolContract.resourceType,
        action: params.toolContract.action,
        fieldRules: params.toolContract.fieldRules ?? null,
        rowFilters: params.toolContract.rowFilters ?? null,
      },
    },
    secretDomain: { connectorInstanceIds: effConnectorInstanceIds },
    egressDomain: { networkPolicy: normalizeNetworkPolicy(effNetworkPolicy) },
    resourceDomain: { limits: effLimits },
  };

  if (!params.requestedCapabilityEnvelope) {
    if (params.requireRequestedEnvelope) return { ok: false, reason: "missing" };
    const finalNetworkPolicy = effectiveEnvelope.egressDomain.networkPolicy;
    return {
      ok: true,
      envelope: effectiveEnvelope,
      limits: effectiveEnvelope.resourceDomain.limits,
      networkPolicy: finalNetworkPolicy,
      networkPolicyDigest: networkPolicyDigest(finalNetworkPolicy.allowedDomains, finalNetworkPolicy.rules ?? null),
      effectiveEnvelope,
    };
  }

  const parsed = validateCapabilityEnvelopeV1(params.requestedCapabilityEnvelope);
  if (!parsed.ok) return { ok: false, reason: "invalid" };

  const rawLimits = (params.requestedCapabilityEnvelope as any)?.resourceDomain?.limits;
  if (rawLimits === undefined || rawLimits === null || (isPlainObject(rawLimits) && Object.keys(rawLimits).length === 0)) {
    parsed.envelope.resourceDomain.limits = effectiveEnvelope.resourceDomain.limits;
  }

  const subset = checkCapabilityEnvelopeNotExceedV1({ envelope: parsed.envelope, effective: effectiveEnvelope });
  if (!subset.ok) return { ok: false, reason: "not_subset", details: { reason: subset.reason } };

  const finalEnvelope = parsed.envelope;
  const finalNetworkPolicy = finalEnvelope.egressDomain.networkPolicy;
  return {
    ok: true,
    envelope: finalEnvelope,
    limits: finalEnvelope.resourceDomain.limits,
    networkPolicy: finalNetworkPolicy,
    networkPolicyDigest: networkPolicyDigest(finalNetworkPolicy.allowedDomains, finalNetworkPolicy.rules ?? null),
    effectiveEnvelope,
  };
}
