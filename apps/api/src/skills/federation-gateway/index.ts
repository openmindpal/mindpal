/**
 * Optional Builtin Skill: Federation Gateway
 *
 * 联邦网关 — 跨实例协作与资源共享。
 * 可通过 DISABLED_BUILTIN_SKILLS=federation.gateway 禁用。
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { federationRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "federation.gateway", version: "1.0.0" },
    routes: ["/governance/federation"],
    frontend: ["/gov/federation"],
    dependencies: ["audit", "rbac"],
  },
  routes: federationRoutes,
};

export default plugin;
