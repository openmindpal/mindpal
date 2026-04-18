import { isPlainObject, normalizeLimits, normalizeNetworkPolicy } from "./runtime";
import type { RuntimeLimits, NetworkPolicy, NetworkPolicyRule } from "./runtime";

export type CapabilityEnvelopeV1 = {
  format: "capabilityEnvelope.v1";
  dataDomain: {
    tenantId: string;
    spaceId: string | null;
    subjectId: string | null;
    toolContract: {
      scope: string;
      resourceType: string;
      action: string;
      fieldRules: {
        read?: { allow?: string[]; deny?: string[] };
        write?: { allow?: string[]; deny?: string[] };
      } | null;
      rowFilters: unknown | null;
    };
  };
  secretDomain: {
    connectorInstanceIds: string[];
  };
  egressDomain: {
    networkPolicy: NetworkPolicy;
  };
  resourceDomain: {
    limits: RuntimeLimits;
  };
};

function stableStringify(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`);
  return `{${parts.join(",")}}`;
}

function normalizeStringArray(input: unknown) {
  const arr = Array.isArray(input) ? input : [];
  return arr.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}



function normalizeFieldRuleSide(v: any) {
  const allow = normalizeStringArray(v?.allow);
  const deny = normalizeStringArray(v?.deny);
  const allowOut = allow.length ? allow : undefined;
  const denyOut = deny.length ? deny : undefined;
  if (!allowOut && !denyOut) return undefined;
  return { allow: allowOut, deny: denyOut };
}

function normalizeFieldRules(v: any) {
  if (v === null) return null;
  if (v === undefined) return null;
  if (!isPlainObject(v)) return null;
  const read = normalizeFieldRuleSide((v as any).read);
  const write = normalizeFieldRuleSide((v as any).write);
  if (!read && !write) return null;
  return { read, write };
}

function fieldRulesNotExceed(child: any, parent: any) {
  const canon = (v: any) => normalizeFieldRules(v) ?? null;
  const c = canon(child);
  const p = canon(parent);
  if (!p) return true;
  if (!c) {
    const pr = p.read;
    const pw = p.write;
    const prDeny = normalizeStringArray(pr?.deny);
    const pwDeny = normalizeStringArray(pw?.deny);
    return prDeny.length === 0 && pwDeny.length === 0;
  }

  const sides: Array<"read" | "write"> = ["read", "write"];
  for (const side of sides) {
    const pc = (p as any)[side];
    const cc = (c as any)[side];
    const pAllow = normalizeStringArray(pc?.allow);
    const pDeny = new Set(normalizeStringArray(pc?.deny));
    const cAllowRaw = normalizeStringArray(cc?.allow);
    const cDeny = new Set(normalizeStringArray(cc?.deny));

    const pAllowAll = pAllow.includes("*") || pAllow.length === 0;
    const cAllowAll = cAllowRaw.includes("*") || cAllowRaw.length === 0;

    if (cAllowAll) {
      for (const d of pDeny) if (!cDeny.has(d)) return false;
      continue;
    }

    if (!pAllowAll) {
      const pSet = new Set(pAllow);
      for (const a of cAllowRaw) if (!pSet.has(a)) return false;
    }
    for (const a of cAllowRaw) if (pDeny.has(a)) return false;
  }
  return true;
}

function normalizeToolContract(v: unknown) {
  const obj = isPlainObject(v) ? v : {};
  const scope = typeof obj.scope === "string" ? obj.scope : "";
  const resourceType = typeof obj.resourceType === "string" ? obj.resourceType : "";
  const action = typeof obj.action === "string" ? obj.action : "";
  const fieldRules = normalizeFieldRules((obj as any).fieldRules);
  const rowFilters = (obj as any).rowFilters ?? null;
  return { scope, resourceType, action, fieldRules, rowFilters };
}

function normalizeEnvelope(v: unknown): CapabilityEnvelopeV1 | null {
  if (!isPlainObject(v)) return null;
  if (String((v as any).format ?? "") !== "capabilityEnvelope.v1") return null;
  const dataDomainRaw = (v as any).dataDomain;
  const secretDomainRaw = (v as any).secretDomain;
  const egressDomainRaw = (v as any).egressDomain;
  const resourceDomainRaw = (v as any).resourceDomain;
  if (!isPlainObject(dataDomainRaw) || !isPlainObject(secretDomainRaw) || !isPlainObject(egressDomainRaw) || !isPlainObject(resourceDomainRaw)) return null;

  const tenantId = typeof dataDomainRaw.tenantId === "string" ? dataDomainRaw.tenantId.trim() : "";
  const spaceId = dataDomainRaw.spaceId === null ? null : typeof dataDomainRaw.spaceId === "string" ? dataDomainRaw.spaceId : null;
  const subjectId = dataDomainRaw.subjectId === null ? null : typeof dataDomainRaw.subjectId === "string" ? dataDomainRaw.subjectId : null;
  const toolContract = normalizeToolContract((dataDomainRaw as any).toolContract);
  if (!tenantId || !toolContract.scope || !toolContract.resourceType || !toolContract.action) return null;

  const connectorInstanceIds = Array.from(new Set(normalizeStringArray((secretDomainRaw as any).connectorInstanceIds)));
  const networkPolicy = normalizeNetworkPolicy((egressDomainRaw as any).networkPolicy);
  const limits = normalizeLimits((resourceDomainRaw as any).limits);

  return {
    format: "capabilityEnvelope.v1",
    dataDomain: { tenantId, spaceId, subjectId, toolContract: { scope: toolContract.scope, resourceType: toolContract.resourceType, action: toolContract.action, fieldRules: toolContract.fieldRules, rowFilters: toolContract.rowFilters } },
    secretDomain: { connectorInstanceIds },
    egressDomain: { networkPolicy },
    resourceDomain: { limits },
  };
}

export function validateCapabilityEnvelopeV1(v: unknown): { ok: true; envelope: CapabilityEnvelopeV1 } | { ok: false; error: string } {
  const env = normalizeEnvelope(v);
  if (!env) return { ok: false, error: "invalid_envelope" };
  return { ok: true, envelope: env };
}

function isAllowedByRule(params: { effRule: NetworkPolicyRule; childRule: NetworkPolicyRule }) {
  if (params.effRule.host.toLowerCase() !== params.childRule.host.toLowerCase()) return false;
  const ep = params.effRule.pathPrefix;
  const cp = params.childRule.pathPrefix;
  if (ep) {
    if (!cp) return false;
    if (!cp.startsWith(ep)) return false;
  }
  const em = params.effRule.methods;
  const cm = params.childRule.methods;
  if (em && em.length) {
    if (!cm || !cm.length) return false;
    const set = new Set(em.map((x) => x.toUpperCase()));
    for (const m of cm) if (!set.has(m.toUpperCase())) return false;
  }
  return true;
}

function networkPolicyNotExceed(child: NetworkPolicy, eff: NetworkPolicy) {
  const effAllowed = new Set(eff.allowedDomains.map((d) => d.toLowerCase()));
  for (const d of child.allowedDomains) {
    if (!effAllowed.has(d.toLowerCase())) return false;
  }
  for (const r of child.rules) {
    if (effAllowed.has(r.host.toLowerCase())) continue;
    const ok = eff.rules.some((er) => isAllowedByRule({ effRule: er, childRule: r }));
    if (!ok) return false;
  }
  return true;
}

function limitsNotExceed(child: RuntimeLimits, eff: RuntimeLimits) {
  if (child.timeoutMs > eff.timeoutMs) return false;
  if (child.maxConcurrency > eff.maxConcurrency) return false;
  if (eff.memoryMb !== null) {
    if (child.memoryMb === null) return false;
    if (child.memoryMb > eff.memoryMb) return false;
  }
  if (eff.cpuMs !== null) {
    if (child.cpuMs === null) return false;
    if (child.cpuMs > eff.cpuMs) return false;
  }
  if (child.maxOutputBytes > eff.maxOutputBytes) return false;
  if (child.maxEgressRequests > eff.maxEgressRequests) return false;
  return true;
}

export function checkCapabilityEnvelopeNotExceedV1(params: {
  envelope: CapabilityEnvelopeV1;
  effective: CapabilityEnvelopeV1;
}): { ok: true } | { ok: false; reason: string } {
  const env = params.envelope;
  const eff = params.effective;
  if (env.format !== "capabilityEnvelope.v1") return { ok: false, reason: "format" };
  if (env.dataDomain.tenantId !== eff.dataDomain.tenantId) return { ok: false, reason: "tenant_mismatch" };
  if ((env.dataDomain.spaceId ?? null) !== (eff.dataDomain.spaceId ?? null)) return { ok: false, reason: "space_mismatch" };
  if ((env.dataDomain.subjectId ?? null) !== (eff.dataDomain.subjectId ?? null)) return { ok: false, reason: "subject_mismatch" };
  if (env.dataDomain.toolContract.scope !== eff.dataDomain.toolContract.scope) return { ok: false, reason: "scope_mismatch" };
  if (env.dataDomain.toolContract.resourceType !== eff.dataDomain.toolContract.resourceType) return { ok: false, reason: "resource_type_mismatch" };
  if (env.dataDomain.toolContract.action !== eff.dataDomain.toolContract.action) return { ok: false, reason: "action_mismatch" };

  if (!fieldRulesNotExceed(env.dataDomain.toolContract.fieldRules, eff.dataDomain.toolContract.fieldRules)) return { ok: false, reason: "field_rules_not_subset" };
  const effRow = eff.dataDomain.toolContract.rowFilters ?? null;
  const envRow = env.dataDomain.toolContract.rowFilters ?? null;
  if (effRow !== null && stableStringify(envRow) !== stableStringify(effRow)) return { ok: false, reason: "row_filters_mismatch" };

  const effConns = new Set(eff.secretDomain.connectorInstanceIds);
  for (const id of env.secretDomain.connectorInstanceIds) if (!effConns.has(id)) return { ok: false, reason: "secret_not_subset" };

  if (!networkPolicyNotExceed(env.egressDomain.networkPolicy, eff.egressDomain.networkPolicy)) return { ok: false, reason: "egress_not_subset" };
  if (!limitsNotExceed(env.resourceDomain.limits, eff.resourceDomain.limits)) return { ok: false, reason: "limits_not_subset" };

  return { ok: true };
}

