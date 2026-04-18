import type { FastifyPluginAsync } from "fastify";
import { orchestratorTurnRoutes } from "./routes.turn";
import { orchestratorExecuteRoutes } from "./routes.execute";
import { orchestratorDispatchRoutes } from "./routes.dispatch";
import { taskQueueRoutes } from "./routes.taskQueue";
import { initVocabLoader } from "./modules/intentVocabLoader";

export const orchestratorRoutes: FastifyPluginAsync = async (app) => {
  // P1: 初始化词表加载器（从 JSON 文件加载 + 启动热更新轮询）
  initVocabLoader();
  app.register(orchestratorDispatchRoutes);  // P0-1: 统一分流入口（优先注册）
  app.register(orchestratorTurnRoutes);
  app.register(orchestratorExecuteRoutes);
  app.register(taskQueueRoutes);             // 多任务队列管理路由
};
