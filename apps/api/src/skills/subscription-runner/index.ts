import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { subscriptionRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "subscription.runner", version: "1.0.0" },
    displayName: { "zh-CN": "订阅执行器", "en-US": "Subscription Runner" },
    description: { "zh-CN": "执行事件订阅和消息分发", "en-US": "Execute event subscriptions and message dispatching" },
    routes: ["/subscriptions"],
    dependencies: ["audit", "rbac"],
  },
  routes: subscriptionRoutes,
};
export default plugin;
