import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { notificationRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "notification.outbox", version: "1.0.0" },
    displayName: { "zh-CN": "通知发件箱", "en-US": "Notification Outbox" },
    description: { "zh-CN": "管理系统通知的发送队列和投递", "en-US": "Manage system notification send queue and delivery" },
    routes: ["/notifications"],
    frontend: ["/gov/notifications"],
    dependencies: ["audit", "rbac", "secrets"],
    skillDependencies: ["connector.manager"],
  },
  routes: notificationRoutes,
};
export default plugin;
