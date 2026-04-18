/**
 * routes/runs — 聚合入口
 *
 * 将原 runs.ts (1539行) 按职责拆分为独立子模块，本文件仅做聚合注册。
 */
import type { FastifyPluginAsync } from "fastify";
import { runsGovernanceRoutes } from "./governance";
import { runsQueryRoutes } from "./query";
import { runsRecoveryRoutes } from "./recovery";
import { runsExecutionRoutes } from "./execution";
import { runsReplanRoutes } from "./replan";

export const runRoutes: FastifyPluginAsync = async (app) => {
  await app.register(runsGovernanceRoutes);
  await app.register(runsQueryRoutes);
  await app.register(runsRecoveryRoutes);
  await app.register(runsExecutionRoutes);
  await app.register(runsReplanRoutes);
};
