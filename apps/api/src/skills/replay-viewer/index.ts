import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { replayRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "replay.viewer", version: "1.0.0" },
    displayName: { "zh-CN": "回放查看器", "en-US": "Replay Viewer" },
    description: { "zh-CN": "查看和回放历史会话操作记录", "en-US": "View and replay historical session operation records" },
    routes: ["/replay"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: replayRoutes,
};

export default plugin;
