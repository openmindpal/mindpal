import type { FastifyPluginAsync } from "fastify";
import { modelCatalogRoutes } from "./routes.catalog";
import { modelBindingRoutes } from "./routes.bindings";
import { modelOnboardRoutes } from "./routes.onboard";
import { modelChatRoutes } from "./routes.chat";
import { loadProtocolFamilyCache } from "./modules/providerAdapterRegistry.js";

export const modelRoutes: FastifyPluginAsync = async (app) => {
  // 插件初始化：加载协议族缓存（DB 不可用时静默降级到硬编码 fallback）
  await loadProtocolFamilyCache((app as any).db);

  // 每 5 分钟刷新缓存（与 CACHE_TTL_MS 一致）
  const refreshInterval = setInterval(() => {
    loadProtocolFamilyCache((app as any).db).catch(() => {});
  }, 5 * 60 * 1000);
  refreshInterval.unref?.();

  app.register(modelCatalogRoutes);
  app.register(modelBindingRoutes);
  app.register(modelOnboardRoutes);
  app.register(modelChatRoutes);
};
