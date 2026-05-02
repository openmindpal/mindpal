/**
 * Unified route guard — eliminates per-route boilerplate for:
 *   1. setAuditContext(req, { resourceType, action, ... })
 *   2. requirePermission({ req, ... })  →  req.ctx.audit!.policyDecision = decision
 *   3. requireSubject(req)
 *
 * Usage:
 *   const subject = await guarded(req, { resourceType: "entity", action: "read", perm: PERM.ENTITY_READ });
 *   // or without permission check (audit-only):
 *   const subject = await guarded(req, { resourceType: "audio", action: "transcribe" });
 */
import type { FastifyRequest } from "fastify";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";

export interface GuardOptions {
  /** Audit resource type (e.g. "entity", "rbac", "device") */
  resourceType: string;
  /** Audit action (e.g. "read", "create", "role.delete") */
  action: string;
  /** Permission descriptor — when provided, requirePermission is invoked and policyDecision is set */
  perm?: { resourceType: string; action: string };
  /** Extra audit fields forwarded to setAuditContext */
  idempotencyKey?: string;
  requireOutbox?: boolean;
  toolRef?: string;
  workflowRef?: string;
}

/**
 * One-liner route guard that replaces the recurring 3-line boilerplate.
 *
 * When `perm` is provided, returns { subject, decision } with a guaranteed decision.
 * When `perm` is omitted, returns { subject, decision: undefined }.
 */
export async function guarded(
  req: FastifyRequest,
  opts: GuardOptions & { perm: { resourceType: string; action: string } },
): Promise<{ subject: ReturnType<typeof requireSubject>; decision: Awaited<ReturnType<typeof requirePermission>> }>;
export async function guarded(
  req: FastifyRequest,
  opts: GuardOptions,
): Promise<{ subject: ReturnType<typeof requireSubject>; decision: Awaited<ReturnType<typeof requirePermission>> | undefined }>;
export async function guarded(req: FastifyRequest, opts: GuardOptions) {
  setAuditContext(req, {
    resourceType: opts.resourceType,
    action: opts.action,
    idempotencyKey: opts.idempotencyKey,
    requireOutbox: opts.requireOutbox,
    toolRef: opts.toolRef,
    workflowRef: opts.workflowRef,
  });

  let decision: Awaited<ReturnType<typeof requirePermission>> | undefined;
  if (opts.perm) {
    decision = await requirePermission({ req, ...opts.perm });
    req.ctx.audit!.policyDecision = decision;
  }

  const subject = requireSubject(req);
  return { subject, decision };
}
