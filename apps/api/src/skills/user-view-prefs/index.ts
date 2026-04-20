import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { userViewConfigRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "user.view-prefs", version: "1.0.0" },
    displayName: { "zh-CN": "用户视图偏好", "en-US": "User View Preferences" },
    description: { "zh-CN": "存储和管理用户的界面偏好设置", "en-US": "Store and manage user interface preference settings" },
    routes: ["/user-view-configs"],
    dependencies: ["audit", "rbac"],
  },
  routes: userViewConfigRoutes,
};

export default plugin;
