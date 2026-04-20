import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { aiEventReasoningRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "ai.event.reasoning", version: "1.0.0" },
    displayName: { "zh-CN": "AI事件推理", "en-US": "AI Event Reasoning" },
    description: { "zh-CN": "基于AI进行事件分析和推理决策", "en-US": "AI-based event analysis and reasoning decisions" },
    routes: ["/governance/event-reasoning"],
    frontend: ["/gov/event-reasoning"],
    dependencies: ["audit", "rbac"],
    skillDependencies: ["orchestrator.chat", "trigger.engine"],
  },
  routes: aiEventReasoningRoutes,
};

export default plugin;
