/**
 * Optional Builtin Skill: Observability Dashboard
 *
 * 可观测性仪表盘 — 运行时指标、质量告警、降级统计。
 * 可通过 DISABLED_BUILTIN_SKILLS=observability.dashboard 禁用。
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { observabilityRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "observability.dashboard", version: "1.0.0" },
    routes: ["/governance/observability", "/governance/run-metrics"],
    frontend: ["/gov/observability"],
    dependencies: ["audit", "rbac"],
  },
  routes: observabilityRoutes,
};

export default plugin;
