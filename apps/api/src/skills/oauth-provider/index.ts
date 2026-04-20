import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { oauthRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "oauth.provider", version: "1.0.0" },
    displayName: { "zh-CN": "OAuth 提供者", "en-US": "OAuth Provider" },
    description: { "zh-CN": "提供 OAuth 2.0 授权认证服务", "en-US": "Provide OAuth 2.0 authorization and authentication service" },
    routes: ["/oauth"],
    dependencies: ["audit", "rbac", "secrets"],
  },
  routes: oauthRoutes,
};
export default plugin;
