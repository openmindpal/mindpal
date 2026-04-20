import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { taskRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "task.manager", version: "1.0.0" },
    displayName: { "zh-CN": "任务管理器", "en-US": "Task Manager" },
    description: { "zh-CN": "管理异步任务的调度和执行", "en-US": "Manage async task scheduling and execution" },
    routes: ["/tasks"],
    frontend: ["/tasks"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: taskRoutes,
};

export default plugin;
