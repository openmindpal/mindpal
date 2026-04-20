import type { ApiError } from "@/lib/apiError";

export type ToolRollout = { scopeType?: string; scopeId?: string; toolRef?: string; enabled?: boolean; disableMode?: string; graceDeadline?: string; createdAt?: string; updatedAt?: string };
export type ActiveToolRef = { name?: string; activeToolRef?: string; updatedAt?: string };
export type ToolDef = {
  name?: string;
  displayName?: unknown;
  description?: unknown;
  scope?: string | null;
  resourceType?: string | null;
  action?: string | null;
  riskLevel?: string;
  approvalRequired?: boolean;
  activeToolRef?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
export type GovernanceToolsResponse = ApiError & { tools?: ToolDef[]; rollouts?: ToolRollout[]; actives?: ActiveToolRef[] };
export type NetworkPolicy = ApiError & {
  tenantId?: string;
  scopeType?: "tenant" | "space";
  scopeId?: string;
  toolRef?: string;
  allowedDomains?: string[];
  updatedAt?: string;
};
export type NetworkPoliciesResponse = ApiError & { items?: NetworkPolicy[] };

/** Shared context passed to each tab sub-component. */
export interface ToolsTabContext {
  locale: string;
  busy: boolean;
  error: string;
  tools: ToolDef[];
  rollouts: ToolRollout[];
  actives: ActiveToolRef[];
  refresh: () => Promise<void>;
  runAction: (fn: () => Promise<unknown>) => Promise<void>;
}
