import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { agentRuntimeRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "agent.runtime", version: "1.0.0" },
    displayName: { "zh-CN": "智能体运行时", "en-US": "Agent Runtime" },
    description: { "zh-CN": "管理智能体的生命周期和运行状态", "en-US": "Manage agent lifecycle and runtime state" },
    routes: ["/agent-runtime"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: agentRuntimeRoutes,
};

export default plugin;
