import type { FastifyPluginAsync } from "fastify";
import { governanceUiRoutes } from "./ui";
import { governanceSchemasRoutes } from "./schemas";
import { governanceArtifactPolicyRoutes } from "./artifactPolicy";
import { governanceToolsRoutes } from "./tools";
import { governancePolicyRoutes } from "./policy";
// observability routes moved to skills/observability-dashboard (optional-builtin Skill)
import { governanceSkillRuntimeRoutes } from "./skillRuntime";
import { governanceChangesetsAndEvalsRoutes } from "./changesetsAndEvals";
import { governanceKnowledgeRoutes } from "./knowledge";
import { governanceIntegrationsRoutes } from "./integrations";
import { governanceCollabRoutes } from "./collab";
import { governanceConfigRoutes } from "./config";
// federation routes moved to skills/federation-gateway (optional-builtin Skill)

export const governanceIndexRoutes: FastifyPluginAsync = async (app) => {
  await app.register(governanceUiRoutes);
  await app.register(governanceSchemasRoutes);
  await app.register(governanceArtifactPolicyRoutes);
  await app.register(governanceToolsRoutes);
  await app.register(governancePolicyRoutes);
  // governanceObservabilityRoutes → now registered via skills/observability-dashboard
  await app.register(governanceSkillRuntimeRoutes);
  await app.register(governanceChangesetsAndEvalsRoutes);
  await app.register(governanceKnowledgeRoutes);
  await app.register(governanceIntegrationsRoutes);
  await app.register(governanceCollabRoutes);
  await app.register(governanceConfigRoutes);
  // governanceFederationRoutes → now registered via skills/federation-gateway
};

