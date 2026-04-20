import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { analyticsApiRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "analytics.engine", version: "1.0.0" },
    displayName: { "zh-CN": "分析引擎", "en-US": "Analytics Engine" },
    description: { "zh-CN": "执行数据分析和统计报表生成", "en-US": "Execute data analytics and generate statistical reports" },
    routes: ["/analytics"],
    frontend: ["/gov/observability"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: analyticsApiRoutes,
};

export default plugin;
