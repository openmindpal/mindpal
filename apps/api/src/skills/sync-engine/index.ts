import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { syncRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "sync.engine", version: "1.0.0" },
    displayName: { "zh-CN": "同步引擎", "en-US": "Sync Engine" },
    description: { "zh-CN": "实现离线数据同步和冲突解决", "en-US": "Implement offline data synchronization and conflict resolution" },
    routes: ["/sync"],
    frontend: ["/gov/sync", "/gov/sync-conflicts"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: syncRoutes,
};

export default plugin;
