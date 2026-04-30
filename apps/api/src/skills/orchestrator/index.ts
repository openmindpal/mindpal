/**
 * Built-in Skill: Orchestrator (Chat/AI)
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { orchestratorRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "orchestrator.chat", version: "1.0.0" },
    displayName: { "zh-CN": "编排器对话", "en-US": "Orchestrator Chat" },
    description: { "zh-CN": "AI对话编排和多轮会话管理", "en-US": "AI conversation orchestration and multi-turn session management" },
    routes: ["/orchestrator"],
    frontend: ["/orchestrator"],
    dependencies: ["schemas", "entities", "tools", "audit", "rbac"],
    skillDependencies: ["model.gateway"],
  },
  routes: orchestratorRoutes,
};

export default plugin;
