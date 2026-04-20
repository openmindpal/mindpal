/**
 * Built-in Skill: UI Page Config
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { uiRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "ui.page-config", version: "1.0.0" },
    displayName: { "zh-CN": "页面配置", "en-US": "Page Config" },
    description: { "zh-CN": "管理前端页面布局和组件配置", "en-US": "Manage frontend page layout and component configuration" },
    routes: ["/ui"],
    frontend: ["/gov/ui-pages"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: uiRoutes,
};

export default plugin;
