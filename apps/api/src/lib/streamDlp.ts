import { attachDlpSummary, redactValue, shouldDenyDlpForTarget } from "@openslin/shared";

import { Errors } from "./errors";
import type { RequestDlpPolicyContext } from "./dlpPolicy";

export function sanitizeSseEvent(params: {
  event: string;
  data: unknown;
  req: any;
  dlpContext: RequestDlpPolicyContext;
}) {
  const { event, data, req, dlpContext } = params;
  if (event === "ping") return { event, data, denied: false };

  const scanned = redactValue(data);
  const target =
    req?.ctx?.audit?.resourceType && req?.ctx?.audit?.action
      ? `${req.ctx.audit.resourceType}:${req.ctx.audit.action}`
      : "";
  const denied = shouldDenyDlpForTarget({
    summary: scanned.summary,
    target,
    policy: dlpContext.policy,
  });

  const dlpSummary = denied
    ? {
        ...scanned.summary,
        disposition: "deny" as const,
        redacted: true,
        mode: dlpContext.policy.mode,
        policyVersion: dlpContext.policy.version,
      }
    : scanned.summary.redacted
      ? {
          ...scanned.summary,
          disposition: "redact" as const,
          mode: dlpContext.policy.mode,
          policyVersion: dlpContext.policy.version,
        }
      : {
          ...scanned.summary,
          mode: dlpContext.policy.mode,
          policyVersion: dlpContext.policy.version,
        };

  if (denied) {
    req.ctx.audit ??= {};
    req.ctx.audit.errorCategory = "policy_violation";
    return {
      event: "error",
      denied: true,
      data: {
        errorCode: "DLP_DENIED",
        message: Errors.dlpDenied().messageI18n,
        traceId: req?.ctx?.traceId,
        requestId: req?.ctx?.requestId,
        blockedEvent: event,
        safetySummary: {
          decision: "denied",
          dlpSummary,
          ...(!dlpContext.configOverride && dlpContext.policyDigest
            ? { policyRefsDigest: { contentPolicyDigest: dlpContext.policyDigest } }
            : {}),
        },
      },
    };
  }

  return {
    event,
    denied: false,
    data: attachDlpSummary(scanned.value, dlpSummary),
  };
}
