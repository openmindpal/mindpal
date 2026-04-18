/**
 * Federation Gateway Skill — 路由入口
 *
 * 复用 routes/governance/federation.ts 中的完整路由实现，
 * 通过 Skill 注册体系实现可插拔（可通过 DISABLED_BUILTIN_SKILLS 禁用）。
 */
import { governanceFederationRoutes } from "../../routes/governance/federation";

export const federationRoutes = governanceFederationRoutes;
