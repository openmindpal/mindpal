import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { triggerRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "trigger.engine", version: "1.0.0" },
    displayName: { "zh-CN": "触发引擎", "en-US": "Trigger Engine" },
    description: { "zh-CN": "管理事件触发器和自动化规则", "en-US": "Manage event triggers and automation rules" },
    routes: ["/triggers"],
    frontend: ["/gov/triggers"],
    dependencies: ["audit", "rbac"],
  },
  routes: triggerRoutes,
};
export default plugin;
