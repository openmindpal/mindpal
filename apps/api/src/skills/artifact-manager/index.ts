import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { artifactRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "artifact.manager", version: "1.0.0" },
    displayName: { "zh-CN": "制品管理器", "en-US": "Artifact Manager" },
    description: { "zh-CN": "管理构建产物和版本化制品的存储与策略", "en-US": "Manage build artifact storage and versioning policies" },
    routes: ["/artifacts"],
    frontend: ["/gov/artifact-policy"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: artifactRoutes,
};

export default plugin;
