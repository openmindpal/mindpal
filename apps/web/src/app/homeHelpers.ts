/**
 * HomeChat — shared types, constants & pure helpers.
 * Extracted from HomeChat.tsx to keep the main component lean.
 */

import { t } from "@/lib/i18n";
import { isPlainObject } from "@/lib/apiError";
import { type ToolSuggestion, type ExecuteResponse } from "@/lib/types";
import { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";

/* ─── Flow types ─────────────────────────────────────────────────────── */

export type FlowMessage = { id: string; role: "user" | "assistant"; text: string };
export type FlowError = { id: string; role: "assistant"; errorCode: string; message: string; traceId: string; retryMessage?: string };
export type UiDirectiveTarget = { kind: "page"; name: string } | { kind: "workbench"; key: string };
export type FlowDirective = { id: string; role: "assistant"; kind: "uiDirective"; directive: unknown; target: UiDirectiveTarget | null };
export type FlowNl2UiResult = {
  id: string; role: "assistant"; kind: "nl2uiResult";
  config: Nl2UiConfig;
  userInput: string;
  suggestions: string[];
};
export type FlowToolSuggestions = { id: string; role: "assistant"; kind: "toolSuggestions"; suggestions: ToolSuggestion[]; turnId?: string };

/** Plan step item - represents a step in an execution plan */
export type FlowPlanStep = {
  id: string;
  role: "assistant";
  kind: "planStep";
  stepIndex: number;
  totalSteps: number;
  toolRef: string;
  name?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "needs_approval";
  runId?: string;
  stepId?: string;
};

/** Execution receipt - represents the result of a tool execution */
export type FlowExecutionReceipt = {
  id: string;
  role: "assistant";
  kind: "executionReceipt";
  runId: string;
  stepId?: string;
  toolRef: string;
  status: "succeeded" | "failed" | "canceled" | "deadletter";
  output?: unknown;
  error?: string;
  latencyMs?: number;
};

/** Approval node - represents an approval request */
export type FlowApprovalNode = {
  id: string;
  role: "assistant";
  kind: "approvalNode";
  approvalId: string;
  runId: string;
  stepId?: string;
  toolRef: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedAt?: string;
};

/** Phase indicator - represents a phase change in the execution */
export type FlowPhaseIndicator = {
  id: string;
  role: "assistant";
  kind: "phaseIndicator";
  phase: "planning" | "executing" | "reviewing" | "succeeded" | "failed";
  runId?: string;
};

/** Artifact card - represents a produced artifact that can be previewed */
export type FlowArtifactCard = {
  id: string;
  role: "assistant";
  kind: "artifactCard";
  artifactType: "json" | "table" | "chart" | "markdown" | "file" | "text";
  title: string;
  summary?: string;
  data?: unknown;
  runId?: string;
  stepId?: string;
  url?: string; // optional URL to view in workspace
};

/** Run summary - represents the final summary of a run */
export type FlowRunSummary = {
  id: string;
  role: "assistant";
  kind: "runSummary";
  runId: string;
  status: "succeeded" | "failed" | "canceled";
  totalSteps: number;
  completedSteps: number;
  totalLatencyMs?: number;
  artifacts?: { type: string; title: string; url?: string }[];
};

export type WorkspaceTab = {
  id: string;
  kind: "page" | "workbench" | "runDetail" | "approvalDetail" | "knowledgeResult" | "artifact" | "nl2uiPreview";
  name: string;
  url: string;
  meta?: {
    runId?: string;
    approvalId?: string;
    artifactType?: "json" | "table" | "chart" | "markdown" | "file" | "text";
    artifactData?: unknown;
    nl2uiConfig?: unknown; // For nl2uiPreview kind
  };
};

export type ToolExecState =
  | { status: "idle" }
  | { status: "executing" }
  | { status: "polling"; runId: string; runStatus?: string }
  | { status: "done"; result: ExecuteResponse; runStatus?: string; stepOutput?: unknown; stepError?: string }
  | { status: "error"; message: string };

export type ChatFlowItem =
  | ({ kind: "message" } & FlowMessage)
  | ({ kind: "error" } & FlowError)
  | FlowDirective
  | FlowNl2UiResult
  | FlowToolSuggestions
  | FlowPlanStep
  | FlowExecutionReceipt
  | FlowApprovalNode
  | FlowPhaseIndicator
  | FlowArtifactCard
  | FlowRunSummary;

/* ─── Constants ──────────────────────────────────────────────────────── */

/** Terminal run statuses – stop polling when we see one of these */
export const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled", "deadletter"]);

export const NAV_ITEMS = [
  { key: "runs", href: "/runs" },
  { key: "tasks", href: "/tasks" },
  { key: "orchestrator", href: "/orchestrator" },
  { key: "governance", href: "/gov/changesets" },
  { key: "settings", href: "/settings" },
] as const;

/* ─── Recent pages (localStorage) ────────────────────────────────────── */

export type RecentEntry = { kind: "page" | "workbench"; name: string; ts: number; url?: string };
const RECENT_KEY = "openslin_recent_pages";
const MAX_RECENT = 12;

export function loadRecent(): RecentEntry[] {
  try { const raw = localStorage.getItem(RECENT_KEY); return raw ? (JSON.parse(raw) as RecentEntry[]) : []; }
  catch { return []; }
}

export function addRecent(entry: Omit<RecentEntry, "ts">) {
  const list = loadRecent().filter((r) => !(r.kind === entry.kind && r.name === entry.name));
  list.unshift({ ...entry, ts: Date.now() });
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
  return list;
}

export function clearRecent() {
  try { localStorage.removeItem(RECENT_KEY); } catch {}
}

/* ─── Favorites (localStorage) ───────────────────────────────────────── */

export type FavoriteEntry = { kind: "page" | "workbench" | "run" | "agent"; name: string; url: string; addedAt: number };
const FAVORITES_KEY = "openslin_favorites";
const MAX_FAVORITES = 20;

export function loadFavorites(): FavoriteEntry[] {
  try { const raw = localStorage.getItem(FAVORITES_KEY); return raw ? (JSON.parse(raw) as FavoriteEntry[]) : []; }
  catch { return []; }
}

export function addFavorite(entry: Omit<FavoriteEntry, "addedAt">): FavoriteEntry[] {
  const list = loadFavorites().filter((f) => !(f.kind === entry.kind && f.name === entry.name));
  list.unshift({ ...entry, addedAt: Date.now() });
  if (list.length > MAX_FAVORITES) list.length = MAX_FAVORITES;
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)); } catch {}
  return list;
}

export function removeFavorite(kind: string, name: string): FavoriteEntry[] {
  const list = loadFavorites().filter((f) => !(f.kind === kind && f.name === name));
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)); } catch {}
  return list;
}

export function isFavorite(kind: string, name: string): boolean {
  return loadFavorites().some((f) => f.kind === kind && f.name === name);
}

export function clearFavorites() {
  try { localStorage.removeItem(FAVORITES_KEY); } catch {}
}

/* ─── Tool helpers ───────────────────────────────────────────────────── */

export function parseToolRef(toolRef: string) {
  const idx = toolRef.lastIndexOf("@");
  const name = idx > 0 ? toolRef.slice(0, idx) : toolRef;
  const version = idx > 0 ? toolRef.slice(idx + 1) : "";
  return { name, version };
}

export function friendlyToolName(locale: string, toolRef: string): string {
  const { name } = parseToolRef(toolRef);
  const key = `chat.toolSuggestion.toolName.${name}`;
  const label = t(locale, key);
  return label !== key ? label : name;
}

export function riskBadgeKey(risk: string): string {
  const r = risk.toLowerCase();
  if (r === "low") return "chat.toolSuggestion.risk.low";
  if (r === "medium" || r === "med") return "chat.toolSuggestion.risk.medium";
  if (r === "high") return "chat.toolSuggestion.risk.high";
  return "chat.toolSuggestion.risk.low";
}

export function friendlyOutputSummary(locale: string, toolRef: string, outputDigest: unknown): { text: string; latencyMs?: number } {
  const toolName = friendlyToolName(locale, toolRef);
  const text = t(locale, "chat.toolSuggestion.outputSummary").replace("{tool}", toolName);
  const latencyMs = isPlainObject(outputDigest) && typeof (outputDigest as any).latencyMs === "number" ? (outputDigest as any).latencyMs as number : undefined;
  return { text, latencyMs };
}

/** Convert technical error codes into user-friendly messages. */
export function friendlyErrorMessage(locale: string, errorCode: string, message?: string): string {
  const code = String(errorCode ?? "").trim();
  if (code) {
    const key = `chat.error.${code}`;
    const mapped = t(locale, key);
    if (mapped !== key) return mapped;
  }
  if (message) return message;
  return t(locale, "chat.error.unknown");
}

export function targetFromUiDirective(d: unknown): UiDirectiveTarget | null {
  if (!isPlainObject(d)) return null;
  const viewParams = d.viewParams;
  if (!isPlainObject(viewParams)) return null;
  if (d.openView === "page") { const n = viewParams.name; if (typeof n !== "string" || !n.trim()) return null; return { kind: "page", name: n.trim() }; }
  if (d.openView === "workbench") { const k = (viewParams.key ?? viewParams.workbenchKey); const key = typeof k === "string" ? k.trim() : ""; if (!key) return null; return { kind: "workbench", key }; }
  return null;
}

/**
 * riskBadgeClass needs CSS module reference — pass the styles object.
 * Returns the appropriate badge CSS class for the given risk level.
 */
export function riskBadgeClass(risk: string, cssStyles: Record<string, string>): string {
  const r = risk.toLowerCase();
  if (r === "medium" || r === "med") return cssStyles.toolSuggestionBadgeMedium;
  if (r === "high") return cssStyles.toolSuggestionBadgeHigh;
  return cssStyles.toolSuggestionBadgeLow;
}
