import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { identityRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "identity.link", version: "1.0.0" },
    displayName: { "zh-CN": "身份关联", "en-US": "Identity Link" },
    description: { "zh-CN": "关联和管理多种外部身份认证源", "en-US": "Link and manage multiple external identity authentication sources" },
    routes: ["/identity-links"],
    dependencies: ["audit", "rbac"],
  },
  routes: identityRoutes,
};

export default plugin;
