import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { yjsRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "yjs.collab", version: "1.0.0" },
    displayName: { "zh-CN": "协同编辑", "en-US": "Collaborative Editing" },
    description: { "zh-CN": "基于 Yjs 的实时协同编辑服务", "en-US": "Yjs-based real-time collaborative editing service" },
    routes: ["/yjs"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: yjsRoutes,
};

export default plugin;
