/* ─── Navigation Configuration ─── */

/** Single navigation item */
export interface NavItemConfig {
  id: string;
  path: string;
  labelKey: string;
  descKey?: string;
  keywordsKey?: string;
}

/** Collapsible sub-group */
export interface NavSubGroupConfig {
  groupKey: string;
  labelKey: string;
  defaultOpen?: boolean;
  items: NavItemConfig[];
}

/** Top-level navigation group */
export interface NavGroupConfig {
  id: string;
  labelKey: string;
  items?: NavItemConfig[];
  subGroups?: NavSubGroupConfig[];
}

export const NAV_CONFIG: NavGroupConfig[] = [
  /* ────── Console ────── */
  {
    id: "console",
    labelKey: "shell.nav.console",
    items: [
      { id: "runs", path: "/runs", labelKey: "shell.nav.runs", descKey: "shell.desc.runs", keywordsKey: "shell.keywords.runs" },
      { id: "tasks", path: "/tasks", labelKey: "shell.nav.tasks", descKey: "shell.desc.tasks", keywordsKey: "shell.keywords.tasks" },
      { id: "settings", path: "/settings", labelKey: "shell.nav.settings", descKey: "shell.desc.settings", keywordsKey: "shell.keywords.settings" },
      { id: "memory", path: "/memory", labelKey: "shell.nav.memory", descKey: "shell.desc.memory", keywordsKey: "shell.keywords.memory" },
      { id: "orchestrator", path: "/orchestrator", labelKey: "shell.nav.orchestrator", descKey: "shell.desc.orchestrator", keywordsKey: "shell.keywords.orchestrator" },
    ],
  },

  /* ────── Governance ────── */
  {
    id: "governance",
    labelKey: "shell.nav.governance",
    subGroups: [
      {
        groupKey: "gov-data",
        labelKey: "gov.group.dataModel",
        defaultOpen: true,
        items: [
          { id: "gov-schemas", path: "/gov/schemas", labelKey: "gov.nav.schemas", descKey: "gov.desc.schemas", keywordsKey: "shell.keywords.gov.schemas" },
        ],
      },
      {
        groupKey: "gov-security",
        labelKey: "gov.group.security",
        items: [
          { id: "gov-safety", path: "/gov/safety-policies", labelKey: "gov.nav.safetyPolicies", descKey: "gov.desc.safetyPolicies", keywordsKey: "shell.keywords.gov.safetyPolicies" },
          { id: "gov-policy-snapshots", path: "/gov/policy-snapshots", labelKey: "gov.nav.policySnapshots", descKey: "gov.desc.policySnapshots", keywordsKey: "shell.keywords.gov.policySnapshots" },
          { id: "gov-policy-debugger", path: "/gov/policy-debugger", labelKey: "gov.nav.policyDebugger", descKey: "gov.desc.policyDebugger", keywordsKey: "shell.keywords.gov.policyDebugger" },
          { id: "gov-artifact-policy", path: "/gov/artifact-policy", labelKey: "gov.nav.artifactPolicy", descKey: "gov.desc.artifactPolicy", keywordsKey: "shell.keywords.gov.artifactPolicy" },
        ],
      },
      {
        groupKey: "gov-tools",
        labelKey: "gov.group.toolsSkills",
        items: [
          { id: "gov-tools", path: "/gov/tools", labelKey: "gov.nav.tools", descKey: "gov.desc.tools", keywordsKey: "shell.keywords.gov.tools" },
          { id: "gov-workbenches", path: "/gov/workbenches", labelKey: "gov.nav.workbenches", descKey: "gov.desc.workbenches", keywordsKey: "shell.keywords.gov.workbenches" },
          { id: "gov-ui-pages", path: "/gov/ui-pages", labelKey: "gov.nav.uiPages", descKey: "gov.desc.uiPages", keywordsKey: "shell.keywords.gov.uiPages" },
          { id: "gov-skill-packages", path: "/gov/skill-packages", labelKey: "gov.nav.skillPackages", descKey: "gov.desc.skillPackages", keywordsKey: "shell.keywords.gov.skillPackages" },
          { id: "gov-skill-runtime", path: "/gov/skill-runtime", labelKey: "gov.nav.skillRuntime", descKey: "gov.desc.skillRuntime", keywordsKey: "shell.keywords.gov.skillRuntime" },
          { id: "gov-collab-runs", path: "/gov/collab-runs", labelKey: "gov.nav.collabRuns", descKey: "gov.desc.collabRuns", keywordsKey: "shell.keywords.gov.collabRuns" },
        ],
      },
      {
        groupKey: "gov-connectivity",
        labelKey: "gov.group.modelChannel",
        items: [
          { id: "gov-models", path: "/gov/models", labelKey: "gov.nav.models", descKey: "gov.desc.models", keywordsKey: "shell.keywords.gov.models" },
          { id: "gov-channels", path: "/gov/channels", labelKey: "gov.nav.channels", descKey: "gov.desc.channels", keywordsKey: "shell.keywords.gov.channels" },
          { id: "gov-triggers", path: "/gov/triggers", labelKey: "gov.nav.triggers", descKey: "gov.desc.triggers", keywordsKey: "shell.keywords.gov.triggers" },
          { id: "gov-devices", path: "/gov/devices", labelKey: "gov.nav.devices", descKey: "gov.desc.devices", keywordsKey: "shell.keywords.gov.devices" },
          { id: "gov-federation", path: "/gov/federation", labelKey: "gov.nav.federation", descKey: "gov.desc.federation", keywordsKey: "shell.keywords.gov.federation" },
          { id: "gov-routing", path: "/gov/routing", labelKey: "gov.nav.routing", descKey: "gov.desc.routing", keywordsKey: "shell.keywords.gov.routing" },
        ],
      },
      {
        groupKey: "gov-integration",
        labelKey: "gov.group.integration",
        items: [
          { id: "gov-notifications", path: "/gov/notifications", labelKey: "gov.nav.notifications", descKey: "gov.desc.notifications", keywordsKey: "shell.keywords.gov.notifications" },
          { id: "gov-integrations", path: "/gov/integrations", labelKey: "gov.nav.integrations", descKey: "gov.desc.integrations", keywordsKey: "shell.keywords.gov.integrations" },
        ],
      },
      {
        groupKey: "gov-knowledge",
        labelKey: "gov.group.knowledge",
        items: [
          { id: "gov-knowledge-docs", path: "/gov/knowledge/documents", labelKey: "gov.nav.knowledgeDocs", descKey: "gov.desc.knowledgeDocs", keywordsKey: "shell.keywords.gov.knowledgeDocs" },
          { id: "gov-knowledge-logs", path: "/gov/knowledge/retrieval-logs", labelKey: "gov.nav.knowledgeLogs", descKey: "gov.desc.knowledgeLogs", keywordsKey: "shell.keywords.gov.knowledgeLogs" },
          { id: "gov-knowledge-jobs", path: "/gov/knowledge/jobs", labelKey: "gov.nav.knowledgeJobs", descKey: "gov.desc.knowledgeJobs", keywordsKey: "shell.keywords.gov.knowledgeJobs" },
          { id: "gov-knowledge-quality", path: "/gov/knowledge/quality", labelKey: "gov.nav.knowledgeQuality", descKey: "gov.desc.knowledgeQuality", keywordsKey: "shell.keywords.gov.knowledgeQuality" },
          { id: "gov-knowledge-engine", path: "/gov/knowledge/engine", labelKey: "gov.nav.knowledgeEngine", descKey: "gov.desc.knowledgeEngine", keywordsKey: "shell.keywords.gov.knowledgeEngine" },
        ],
      },
      /* Task #3: Split gov-audit into two sub-groups */
      {
        groupKey: "gov-release",
        labelKey: "gov.group.release",
        items: [
          { id: "gov-changesets", path: "/gov/changesets", labelKey: "gov.nav.changesets", descKey: "gov.desc.changesets", keywordsKey: "shell.keywords.gov.changesets" },
          { id: "gov-approvals", path: "/gov/approvals", labelKey: "gov.nav.approvals", descKey: "gov.desc.approvals", keywordsKey: "shell.keywords.gov.approvals" },
          { id: "gov-deadletters", path: "/gov/workflow/deadletters", labelKey: "gov.nav.workflowDeadletters", descKey: "gov.desc.workflowDeadletters", keywordsKey: "shell.keywords.gov.workflowDeadletters" },
        ],
      },
      {
        groupKey: "gov-monitor",
        labelKey: "gov.group.monitor",
        items: [
          { id: "gov-audit", path: "/gov/audit", labelKey: "gov.nav.audit", descKey: "gov.desc.audit", keywordsKey: "shell.keywords.gov.audit" },
          { id: "gov-observability", path: "/gov/observability", labelKey: "gov.nav.observability", descKey: "gov.desc.observability", keywordsKey: "shell.keywords.gov.observability" },
          { id: "gov-sync", path: "/gov/sync", labelKey: "gov.nav.sync", descKey: "gov.desc.sync", keywordsKey: "shell.keywords.gov.sync" },
          { id: "gov-sync-conflicts", path: "/gov/sync-conflicts", labelKey: "gov.nav.syncConflicts", descKey: "gov.desc.syncConflicts", keywordsKey: "shell.keywords.gov.syncConflicts" },
        ],
      },
    ],
  },

  /* ────── Admin ────── */
  {
    id: "admin",
    labelKey: "shell.nav.admin",
    subGroups: [
      {
        groupKey: "admin-identity",
        labelKey: "admin.group.identity",
        defaultOpen: true,
        items: [
          { id: "admin-sso", path: "/admin/sso-providers", labelKey: "admin.sso.title", descKey: "admin.sso.desc", keywordsKey: "shell.keywords.admin.sso" },
          { id: "admin-scim", path: "/admin/scim", labelKey: "admin.scim.title", descKey: "admin.scim.desc", keywordsKey: "shell.keywords.admin.scim" },
          { id: "admin-org", path: "/admin/organizations", labelKey: "admin.org.title", descKey: "admin.org.desc", keywordsKey: "shell.keywords.admin.org" },
        ],
      },
      {
        groupKey: "admin-system",
        labelKey: "admin.group.system",
        items: [
          { id: "admin-rbac", path: "/admin/rbac", labelKey: "home.adminRbac", descKey: "admin.rbac.desc", keywordsKey: "shell.keywords.admin.rbac" },
          { id: "admin-backups", path: "/admin/backups", labelKey: "shell.nav.backups", descKey: "shell.desc.backups", keywordsKey: "shell.keywords.admin.backups" },
        ],
      },
    ],
  },
];

/* ─── Extra items that appear in palette but NOT in the sidebar nav groups ─── */
export const EXTRA_PALETTE_ITEMS: NavItemConfig[] = [
  { id: "home", path: "/", labelKey: "app.title", keywordsKey: "shell.keywords.home" },
  { id: "docs", path: "/docs", labelKey: "shell.nav.docs", keywordsKey: "shell.keywords.docs" },
];
