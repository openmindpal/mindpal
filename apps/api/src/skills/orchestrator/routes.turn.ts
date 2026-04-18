import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { clearSessionContext } from "../../modules/memory/sessionContextRepo";

export const orchestratorTurnRoutes: FastifyPluginAsync = async (app) => {
  app.post("/orchestrator/conversations/clear", async (req) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "conversation.clear" });
    const decision = await requirePermission({ req, ...PERM.ORCHESTRATOR_TURN });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z.object({ conversationId: z.string().min(1).max(200) }).parse(req.body);
    const deleted = await clearSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, sessionId: body.conversationId });
    req.ctx.audit!.outputDigest = { conversationId: body.conversationId, deleted };
    return { deleted };
  });
};
