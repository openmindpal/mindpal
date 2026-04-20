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
    displayName: { "zh-CN": "可观测性仪表盘", "en-US": "Observability Dashboard" },
    description: { "zh-CN": "系统监控指标、质量告警和运行状态的可视化", "en-US": "Visualize system monitoring metrics, quality alerts and runtime status" },
    routes: ["/governance/observability", "/governance/run-metrics"],
    frontend: ["/gov/observability"],
    dependencies: ["audit", "rbac"],
  },
  routes: observabilityRoutes,
};

export default plugin;
