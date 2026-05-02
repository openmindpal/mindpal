import type { I18nText } from "./api";
import type { ApiError } from "./apiError";
import { t } from "./i18n";

export type SearchParams = Record<string, string | string[] | undefined>;

export type FieldType = "string" | "number" | "boolean" | "json" | "datetime" | "reference";

export type FieldDef = {
  type?: FieldType;
  required?: boolean;
  displayName?: I18nText | string;
  /** For type=="reference": the target entity name (e.g. "customer") */
  referenceEntity?: string;
  /** Vendor extensions keyed by namespace (e.g. "io.mindpal.ui") */
  extensions?: Record<string, unknown>;
};

export type EffectiveSchema = {
  displayName?: I18nText | string;
  fields?: Record<string, FieldDef>;
};

export type UiNavItem = {
  name: string;
  title?: I18nText | string;
  pageType: string;
  href: string;
  target?: string;
};

export type UiNavigation = {
  items?: UiNavItem[];
};

export type UiActionBinding = {
  action?: string;
  toolRef: string;
};

export type UiLayout = {
  variant?: string;
  density?: "comfortable" | "compact";
};

export type UiBlock = {
  slot: string;
  componentId: string;
  props?: Record<string, unknown>;
};

export type UiListUi = {
  columns?: string[];
  filters?: string[];
  sortOptions?: Array<{ field: string; direction: "asc" | "desc" }>;
  pageSize?: number;
};

export type UiDetailUi = {
  fieldOrder?: string[];
  groups?: Array<{ title?: I18nText | string; fields: string[] }>;
};

export type UiFormUi = {
  fieldOrder?: string[];
  groups?: Array<{ title?: I18nText | string; fields: string[] }>;
};

export type UiPageUi = {
  layout?: UiLayout;
  blocks?: UiBlock[];
  list?: UiListUi;
  detail?: UiDetailUi;
  form?: UiFormUi;
};

export type UiDataBinding =
  | { target: "entities.list"; entityName: string }
  | { target: "entities.query"; entityName: string; schemaName?: string; query?: Record<string, unknown> }
  | { target: "entities.get"; entityName: string; idParam?: string }
  | { target: "schema.effective"; entityName: string; schemaName?: string };

export type UiPageVersion = {
  name: string;
  pageType: string;
  title?: I18nText | string;
  version?: number;
  params?: Record<string, unknown>;
  dataBindings?: UiDataBinding[];
  actionBindings?: UiActionBinding[];
  ui?: UiPageUi;
};

/* ─── Shared orchestrator/chat types (§08 AI Orchestrator) ────────────── */

export type ToolSuggestion = {
  suggestionId?: string;
  toolRef?: string;
  inputDraft?: unknown;
  scope?: string;
  resourceType?: string;
  action?: string;
  riskLevel?: string;
  approvalRequired?: boolean;
  approvalReason?: string;
  idempotencyKey?: string;
};

export type TurnResponse = ApiError & {
  turnId?: string;
  conversationId?: string;
  replyText?: Record<string, string> | string;
  uiDirective?: unknown;
  toolSuggestions?: ToolSuggestion[];
};

export type ExecuteResponse = ApiError & {
  jobId?: string;
  runId?: string;
  stepId?: string;
  approvalId?: string;
  idempotencyKey?: string;
  receipt?: { status?: string; correlation?: Record<string, unknown> };
};

/* ─── P0: Unified Dispatch types ────────────────── */

export type IntentMode = "answer" | "execute" | "collab";

export type IntentClassification = {
  mode: IntentMode;
  confidence: number;
  reason: string;
  needsTask: boolean;
  needsApproval: boolean;
  complexity: "simple" | "moderate" | "complex";
};

export type ExecutionClass = "conversation" | "immediate_action" | "workflow" | "collab";

export type TaskState = {
  phase: string;
  stepCount?: number;
  currentStep?: number;
  needsApproval?: boolean;
  blockReason?: string;
  /** P1-3.2: current execution role */
  role?: string;
  /** P1-3.3: next action hint */
  nextAction?: string;
  /** P1-3.4: evidence or artifact summary */
  evidence?: unknown;
  /** P1-3.5: approval status */
  approvalStatus?: string;
  /** task summary */
  taskSummary?: string;
};

export type DispatchResponse = ApiError & {
  mode: IntentMode;
  executionClass?: ExecutionClass;
  classification: IntentClassification;
  conversationId: string;
  replyText?: string;
  toolSuggestions?: ToolSuggestion[];
  taskId?: string;
  runId?: string;
  jobId?: string;
  collabRunId?: string;
  phase?: string;
  taskState?: TaskState;
  turnId?: string;
  uiDirective?: unknown;
  actionReceipt?: {
    status: "completed" | "suggested";
    toolCount?: number;
    summary?: string;
  };
};

/* ─── P1-1: Run phase labels ─── */
export const RUN_PHASE_LABELS: Record<string, string> = {
  created: "run.phase.created",
  queued: "run.phase.queued",
  retrieving: "run.phase.retrieving",
  planning: "run.phase.planning",
  planned: "run.phase.planned",
  guarded: "run.phase.guarded",
  running: "run.phase.running",
  executing: "run.phase.executing",
  reviewing: "run.phase.reviewing",
  needs_approval: "run.phase.needs_approval",
  needs_device: "run.phase.needs_device",
  needs_arbiter: "run.phase.needs_arbiter",
  paused: "run.phase.paused",
  succeeded: "run.phase.succeeded",
  failed: "run.phase.failed",
  stopped: "run.phase.stopped",
  canceled: "run.phase.canceled",
  compensating: "run.phase.compensating",
  compensated: "run.phase.compensated",
};

export function getPhaseLabel(phase: string, locale: string): string {
  const key = RUN_PHASE_LABELS[phase];
  return key ? t(locale, key) : phase;
}

export function isPhaseTerminal(phase: string): boolean {
  return ["succeeded", "failed", "stopped", "canceled", "compensated"].includes(phase);
}

export function isPhaseBlocking(phase: string): boolean {
  return ["needs_approval", "needs_device", "needs_arbiter", "paused"].includes(phase);
}

export function isPhaseActive(phase: string): boolean {
  return ["queued", "retrieving", "planning", "executing", "reviewing", "running", "compensating"].includes(phase);
}

/* ─── Multi-Agent Collaboration types (§18) ────────────────── */

export interface CollabRun {
  collabRunId: string;
  taskId: string;
  status: string;
  roles: CollabRole[];
  limits?: Record<string, unknown>;
  primaryRunId?: string | null;
  spaceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CollabRole {
  roleName: string;
  agentType?: string;
  mode?: string;
  status?: string;
  capabilities?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  toolPolicy?: { allowedTools?: string[] } | null;
  budget?: Record<string, unknown> | null;
}

export interface CollabRunEvent {
  eventId: string;
  collabRunId: string;
  type: string;
  actorRole?: string | null;
  correlationId?: string | null;
  payloadDigest?: Record<string, unknown> | null;
  runId?: string | null;
  stepId?: string | null;
  createdAt?: string;
}

export interface CollabEnvelope {
  envelopeId: string;
  collabRunId: string;
  fromRole: string;
  toRole?: string | null;
  broadcast?: boolean;
  kind: string;
  correlationId: string;
  payloadDigest?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface CollabState {
  collabRunId: string;
  phase?: string | null;
  currentTurn?: number;
  currentRole?: string | null;
  roleStates?: Record<string, unknown>;
  completedStepIds?: string[];
  failedStepIds?: string[];
  pendingStepIds?: string[];
  replanCount?: number;
  startedAt?: string | null;
  lastUpdatedAt?: string | null;
  version?: number | null;
}

export interface CollabStateUpdate {
  updateId: string;
  sourceRole: string;
  updateType: string;
  payload?: unknown;
  version?: number;
  createdAt?: string;
}

export interface CollabProtocol {
  roles: CollabAgentRole[];
  assignments: CollabTaskAssignment[];
  permissionContexts: CollabPermissionContext[];
}

export interface CollabAgentRole {
  roleId: string;
  collabRunId: string;
  roleName: string;
  agentType: string;
  status: string;
  capabilities?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  policySnapshotRef?: string | null;
  createdAt?: string;
}

export interface CollabTaskAssignment {
  assignmentId: string;
  collabRunId: string;
  taskId: string;
  assignedRole: string;
  status: string;
  priority?: number;
  inputDigest?: Record<string, unknown>;
  outputDigest?: Record<string, unknown>;
  createdAt?: string;
}

export interface CollabPermissionContext {
  contextId: string;
  collabRunId: string;
  roleName: string;
  scope?: string;
  grantedPermissions?: string[];
  createdAt?: string;
}

export interface ConsensusVote {
  topic: string;
  votes: { agentId: string; decision: string; reason: string }[];
  outcome: string;
}

export interface DebateRound {
  round: number;
  speaker: string;
  argument: string;
  stance: string;
}

export interface CollabDetailSnapshot {
  collabRun: CollabRun;
  runs: Record<string, unknown>[];
  latestEvents: CollabRunEvent[];
  collabState: CollabState | null;
  recentStateUpdates: CollabStateUpdate[];
  taskState: TaskState | null;
  envelopes?: { items: CollabEnvelope[]; nextBefore: string | null };
}

/* ─── Offline Sync Conflict types (§15) ────────────────── */

export interface SyncConflict {
  id: string;
  entityName: string;
  fieldName: string;
  localValue: unknown;
  remoteValue: unknown;
  conflictAt: string;
  status: 'pending' | 'resolved';
  resolution?: 'local' | 'remote' | 'manual';
}

export interface ChangeLogEntry {
  id: string;
  timestamp: string;
  operation: 'create' | 'update' | 'delete';
  entityName: string;
  entityId: string;
  changes: Record<string, { old: unknown; new: unknown }>;
}
