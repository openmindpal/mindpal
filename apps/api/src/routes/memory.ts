/**
 * P3: 记忆管理路由 — 确认/拒绝待确认记忆
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { confirmOrRejectMemory } from "../modules/memory/repo";

const confirmBodySchema = z.object({
  decision: z.enum(["confirm", "reject"]),
});

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  // P3: 确认或拒绝待确认的记忆
  app.post<{
    Params: { id: string };
    Body: { decision: "confirm" | "reject" };
  }>("/memory/:id/confirm", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { decision } = confirmBodySchema.parse(req.body);

    const subject = req.ctx.subject!;
    if (!subject.tenantId) {
      return reply.status(400).send({ error: "Missing tenantId" });
    }

    const result = await confirmOrRejectMemory(
      app.db,
      subject.tenantId,
      id,
      decision,
    );

    return reply.send({ ok: true, updated: result.updated });
  });
};
