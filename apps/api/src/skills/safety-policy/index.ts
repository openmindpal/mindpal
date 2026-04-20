import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { safetyPolicyRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "safety.policy", version: "1.0.0" },
    displayName: { "zh-CN": "安全策略", "en-US": "Safety Policy" },
    description: { "zh-CN": "管理内容安全和数据防护策略", "en-US": "Manage content safety and data protection policies" },
    routes: ["/safety-policies"],
    frontend: ["/gov/safety-policies"],
    dependencies: ["audit", "rbac"],
  },
  routes: safetyPolicyRoutes,
};
export default plugin;
