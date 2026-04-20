import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { ssoRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "sso.provider", version: "1.0.0" },
    displayName: { "zh-CN": "单点登录提供者", "en-US": "SSO Provider" },
    description: { "zh-CN": "提供 SAML/OIDC 单点登录服务", "en-US": "Provide SAML/OIDC single sign-on service" },
    routes: ["/sso"],
    dependencies: ["audit", "rbac"],
  },
  routes: ssoRoutes,
};
export default plugin;
