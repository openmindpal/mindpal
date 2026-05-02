import {
  resolveDlpPolicy,
  resolveDlpPolicyFromEnv,
  resolveRuntimeConfig,
  type DlpPolicy,
  type RuntimeConfigOverrides,
} from "@mindpal/shared";

import { getHotConfigEngine } from "./hotConfigEngine";
import { getEffectiveSafetyPolicyVersion } from "./safetyContract";

type RequestSubject = {
  tenantId: string;
  spaceId?: string;
};

export type RequestDlpPolicyContext = {
  policy: DlpPolicy;
  configOverride: boolean;
  policyDigest?: string | null;
};

function hasDlpConfigOverride(tenantOverrides: RuntimeConfigOverrides = {}) {
  const env = process.env as Record<string, string | undefined>;
  const modeR = resolveRuntimeConfig("DLP_MODE", env, tenantOverrides);
  const targetsR = resolveRuntimeConfig("DLP_DENY_TARGETS", env, tenantOverrides);
  const hitTypesR = resolveRuntimeConfig("DLP_DENY_HIT_TYPES", env, tenantOverrides);
  return modeR.source !== "default" || targetsR.source !== "default" || hitTypesR.source !== "default";
}

function resolveDlpPolicyFromOverrides(tenantOverrides: RuntimeConfigOverrides = {}) {
  const env = process.env as Record<string, string | undefined>;
  const mode = resolveRuntimeConfig("DLP_MODE", env, tenantOverrides).value;
  const targets = resolveRuntimeConfig("DLP_DENY_TARGETS", env, tenantOverrides).value;
  const hitTypes = resolveRuntimeConfig("DLP_DENY_HIT_TYPES", env, tenantOverrides).value;
  return resolveDlpPolicy({ version: "v1", mode, denyTargets: targets, denyHitTypes: hitTypes });
}

export function resolveFallbackRequestDlpPolicyContext(): RequestDlpPolicyContext {
  return {
    policy: resolveDlpPolicyFromEnv(),
    configOverride: true,
    policyDigest: null,
  };
}

export async function resolveRequestDlpPolicyContext(params: {
  db?: any;
  subject?: RequestSubject;
}): Promise<RequestDlpPolicyContext> {
  const { db, subject } = params;
  if (!subject) return resolveFallbackRequestDlpPolicyContext();

  let tenantOverrides: RuntimeConfigOverrides = {};
  const engine = getHotConfigEngine();
  if (engine) {
    try {
      tenantOverrides = await engine.getOverrides(subject.tenantId);
    } catch {
      tenantOverrides = {};
    }
  }

  const configOverride = hasDlpConfigOverride(tenantOverrides);
  if (!configOverride && db) {
    const eff = await getEffectiveSafetyPolicyVersion({
      pool: db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      policyType: "content",
    });
    if (eff?.policyJson) {
      return {
        policy: resolveDlpPolicy(eff.policyJson as any),
        configOverride: false,
        policyDigest: eff.policyDigest ? String(eff.policyDigest) : null,
      };
    }
  }

  return {
    policy: resolveDlpPolicyFromOverrides(tenantOverrides),
    configOverride,
    policyDigest: null,
  };
}
