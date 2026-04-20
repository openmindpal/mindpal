/**
 * Built-in Skill: Workbench Manager
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { workbenchRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "workbench.manager", version: "1.0.0" },
    displayName: { "zh-CN": "工作台管理器", "en-US": "Workbench Manager" },
    description: { "zh-CN": "管理用户工作台的布局和版本", "en-US": "Manage user workbench layout and versions" },
    routes: ["/workbenches"],
    frontend: ["/gov/workbenches"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: workbenchRoutes,
};

export default plugin;
