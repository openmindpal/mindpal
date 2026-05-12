import type { FastifyPluginAsync } from "fastify";

interface VitalsPayload {
  name: string;
  value: number;
  delta: number;
  id: string;
  rating: string;
  navigationType?: string;
}

export const vitalsRoutes: FastifyPluginAsync = async (app) => {
  /* POST /v1/metrics/vitals — 接收前端上报的 Web Vitals 指标 */
  app.post("/v1/metrics/vitals", async (req, reply) => {
    const body = req.body as VitalsPayload;

    // 基本校验
    if (
      !body ||
      typeof body.name !== "string" ||
      typeof body.value !== "number" ||
      typeof body.delta !== "number" ||
      typeof body.id !== "string" ||
      typeof body.rating !== "string"
    ) {
      return reply.status(400).send({ error: "Invalid vitals payload" });
    }

    req.log.info(
      { metric: body.name, value: body.value, delta: body.delta, rating: body.rating, metricId: body.id, navigationType: body.navigationType },
      `[Web Vitals] ${body.name}=${body.value} (${body.rating})`,
    );

    return reply.status(204).send();
  });
};
