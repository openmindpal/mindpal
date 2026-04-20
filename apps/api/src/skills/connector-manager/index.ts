import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { connectorRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "connector.manager", version: "1.0.0" },
    displayName: { "zh-CN": "连接器管理", "en-US": "Connector Manager" },
    description: { "zh-CN": "管理外部服务连接器的配置和状态", "en-US": "Manage external service connector configuration and status" },
    routes: ["/connectors"],
    frontend: ["/gov/integrations"],
    dependencies: ["audit", "rbac", "secrets"],
  },
  routes: connectorRoutes,
};
export default plugin;
