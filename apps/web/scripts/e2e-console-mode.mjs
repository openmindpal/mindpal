import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const shouldRun = process.env.WEB_E2E === "1";
if (!shouldRun) process.exit(0);

const apiBase = process.env.API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
const webBase = process.env.WEB_BASE ?? "http://localhost:3000";
const locale = process.env.LOCALE ?? "zh-CN";

async function readHomeChatModules() {
  const base = path.resolve(process.cwd(), "src", "app");
  const files = [
    "HomeChat.tsx", "useChatSession.ts", "useTaskManager.ts",
    "useToolExecution.ts", "useSendMessage.ts", "useDirectives.ts",
    "useWorkspaceTabs.tsx", "useSplitLayout.ts",
  ];
  const parts = await Promise.all(files.map((f) => fs.readFile(path.resolve(base, f), "utf8").catch(() => "")));
  return parts.join("\n");
}

async function assertHomeChatToolSuggestionsSupport() {
  const code = await readHomeChatModules();
  if (!code.includes('case "toolSuggestions"')) throw new Error("homechat_missing_toolsuggestions_case");
  if (!code.includes('it.kind === "toolSuggestions"')) throw new Error("homechat_missing_toolsuggestions_render");
}

/* ─── Five-State Architecture Component Assertions ─── */

async function assertFiveStateArchitectureComponents() {
  const code = await readHomeChatModules();

  // P0-系统态: StatusBar (顶栏 Mission Control)
  if (!code.includes('import StatusBar from')) throw new Error("missing_statusbar_import");
  if (!code.includes('<StatusBar')) throw new Error("missing_statusbar_render");

  // P0-个人态: ActiveRunList, PendingActionsQueue 在 BottomTray 中统一承载; RecentAndFavorites 在 HomeChat 中
  const bottomTrayPath = path.resolve(process.cwd(), "src", "components", "shell", "BottomTray.tsx");
  const trayCode = await fs.readFile(bottomTrayPath, "utf8");
  if (!trayCode.includes('import ActiveRunList from')) throw new Error("missing_activerunlist_import");
  if (!trayCode.includes('<ActiveRunList')) throw new Error("missing_activerunlist_render");
  if (!trayCode.includes('import PendingActionsQueue from')) throw new Error("missing_pendingactionsqueue_import");
  if (!trayCode.includes('<PendingActionsQueue')) throw new Error("missing_pendingactionsqueue_render");
  if (!code.includes('import RecentAndFavorites from')) throw new Error("missing_recentandfavorites_import");
  if (!code.includes('<RecentAndFavorites')) throw new Error("missing_recentandfavorites_render");

  // P0-智能体态: FlowItemRenderer components (only ApprovalNodeRenderer kept; others replaced by rich-text stream)
  if (!code.includes('ApprovalNodeRenderer')) throw new Error("missing_approvalnode_renderer");

  // P0-对象态: Workspace Tab types
  if (!code.includes('kind: "artifact"')) throw new Error("missing_artifact_tab_kind");
  if (!code.includes('kind: "runDetail"')) throw new Error("missing_rundetail_tab_kind");
  if (!code.includes('kind: "approvalDetail"')) throw new Error("missing_approvaldetail_tab_kind");
  if (!code.includes('ArtifactPreview')) throw new Error("missing_artifactpreview_component");

  // P1-后台态: BottomTray
  if (!code.includes('import BottomTray from')) throw new Error("missing_bottomtray_import");
  if (!code.includes('<BottomTray')) throw new Error("missing_bottomtray_render");
}

async function assertBottomTraySubPanels() {
  const bottomTrayPath = path.resolve(process.cwd(), "src", "components", "shell", "BottomTray.tsx");
  const code = await fs.readFile(bottomTrayPath, "utf8");

  // RunHistoryPanel
  if (!code.includes('import RunHistoryPanel from')) throw new Error("missing_runhistorypanel_import");
  if (!code.includes('<RunHistoryPanel')) throw new Error("missing_runhistorypanel_render");

  // NotificationPanel
  if (!code.includes('import NotificationPanel from')) throw new Error("missing_notificationpanel_import");
  if (!code.includes('<NotificationPanel')) throw new Error("missing_notificationpanel_render");

  // DeviceActionsPanel
  if (!code.includes('import DeviceActionsPanel from')) throw new Error("missing_deviceactionspanel_import");
  if (!code.includes('<DeviceActionsPanel')) throw new Error("missing_deviceactionspanel_render");

  // Tray tabs
  if (!code.includes('"runs"')) throw new Error("missing_runs_tab");
  if (!code.includes('"notifications"')) throw new Error("missing_notifications_tab");
  if (!code.includes('"deviceActions"')) throw new Error("missing_deviceactions_tab");
}

async function assertArtifactPreviewTypes() {
  const previewPath = path.resolve(process.cwd(), "src", "components", "artifact", "ArtifactPreview.tsx");
  const code = await fs.readFile(previewPath, "utf8");

  // Preview type handlers
  if (!code.includes('case "json"')) throw new Error("missing_json_preview_case");
  if (!code.includes('case "table"')) throw new Error("missing_table_preview_case");
  if (!code.includes('case "chart"')) throw new Error("missing_chart_preview_case");
  if (!code.includes('case "markdown"')) throw new Error("missing_markdown_preview_case");
}

async function assertWorkspaceTabDragAndDrop() {
  const code = await readHomeChatModules();

  // Drag handlers
  if (!code.includes('handleTabDragStart')) throw new Error("missing_tab_dragstart_handler");
  if (!code.includes('handleTabDragOver')) throw new Error("missing_tab_dragover_handler");
  if (!code.includes('handleTabDrop')) throw new Error("missing_tab_drop_handler");
  if (!code.includes('draggable')) throw new Error("missing_draggable_attribute");
}

async function assertFlowItemRenderers() {
  const rendererPath = path.resolve(process.cwd(), "src", "components", "flow", "FlowItemRenderer.tsx");
  const code = await fs.readFile(rendererPath, "utf8");

  // Renderer exports (only ApprovalNodeRenderer kept; others replaced by rich-text stream)
  if (!code.includes('export function ApprovalNodeRenderer')) throw new Error("missing_approvalnode_renderer_export");
}

/* ─── Critical Path: Conversation → Task → Approval → Artifact → Workspace ─── */

async function assertCriticalPathComponents() {
  const code = await readHomeChatModules();

  // 1. Conversation → Task: orchestrator dispatch/stream handling
  if (!code.includes('/orchestrator/dispatch/stream')) throw new Error("missing_orchestrator_stream_endpoint");
  if (!code.includes('toolSuggestions')) throw new Error("missing_toolsuggestions_event_handling");

  // 2. Task → Approval: execute inline with approval detection
  if (!code.includes('executeToolInline')) throw new Error("missing_execute_tool_inline");
  if (!code.includes('needs_approval')) throw new Error("missing_approval_status_handling");

  // 3. Approval → Artifact: run result polling with artifact extraction
  if (!code.includes('pollRunResult')) throw new Error("missing_poll_run_result");
  if (!code.includes('stepOutput')) throw new Error("missing_step_output_handling");

  // 4. Artifact → Workspace: open artifact in workspace dock
  if (!code.includes('openInWorkspace')) throw new Error("missing_open_in_workspace");
  if (!code.includes('kind: "artifact"')) throw new Error("missing_artifact_workspace_kind");

  // Verify homeHelpers has required types (FlowApprovalNode kept; FlowArtifactCard/FlowRunSummary removed)
  const helpersPath = path.resolve(process.cwd(), "src", "app", "homeHelpers.ts");
  const helpers = await fs.readFile(helpersPath, "utf8");
  if (!helpers.includes('FlowApprovalNode')) throw new Error("missing_flowapprovalnode_type");
}

async function assertI18nCompleteness() {
  const zhPath = path.resolve(process.cwd(), "src", "locales", "zh-CN.json");
  const enPath = path.resolve(process.cwd(), "src", "locales", "en-US.json");
  const zh = JSON.parse(await fs.readFile(zhPath, "utf8"));
  const en = JSON.parse(await fs.readFile(enPath, "utf8"));

  // Five-State i18n keys (using actual key patterns in the codebase)
  const requiredKeys = [
    "statusBar.pendingApprovals",
    "statusBar.failedRuns",
    "statusBar.devices",
    "activeRuns.title",
    "pendingActions.title",
    "recentFav.recentTab",
    "bottomTray.runs",
    "bottomTray.notifications",
    "bottomTray.deviceActions",
    "artifact.preview",
    "flowItem.runSummary.succeeded",
    "flowItem.runSummary.failed",
    "flowItem.runSummary.steps",
  ];

  for (const key of requiredKeys) {
    if (zh[key] === undefined) throw new Error(`missing_i18n_zh_${key}`);
    if (en[key] === undefined) throw new Error(`missing_i18n_en_${key}`);
  }
}

/* ─── Performance Baseline ─── */

async function assertFirstScreenPerformance() {
  const startTime = Date.now();
  const res = await fetch(`${webBase}/?lang=${encodeURIComponent(locale)}`, {
    headers: { "cache-control": "no-cache" },
  });
  const html = await res.text();
  const loadTime = Date.now() - startTime;

  // Performance baseline: first screen should load within 3s
  const BASELINE_MS = 3000;
  if (loadTime > BASELINE_MS) {
    console.warn(`[PERF WARNING] First screen load time ${loadTime}ms exceeds baseline ${BASELINE_MS}ms`);
  } else {
    console.log(`[PERF] First screen load time: ${loadTime}ms (baseline: ${BASELINE_MS}ms)`);
  }

  // Verify critical content is present in initial render
  if (!html.includes('data-testid="status-bar"') && !html.includes('StatusBar')) {
    console.log("[PERF] Note: StatusBar rendered client-side (expected for React components)");
  }

  return { loadTime, baseline: BASELINE_MS, passed: loadTime <= BASELINE_MS };
}

async function assertLocalStoragePersistence() {
  const code = await readHomeChatModules();

  // Verify localStorage keys are used for state persistence
  const requiredKeys = [
    "openslin_chat_session",     // Conversation state
    "openslin_workspace_tabs",   // Workspace tabs
    "openslin_split_layout",     // Layout state
  ];

  for (const key of requiredKeys) {
    if (!code.includes(key)) throw new Error(`missing_localstorage_key_${key}`);
  }

  // Verify BottomTray also uses localStorage
  const trayPath = path.resolve(process.cwd(), "src", "components", "shell", "BottomTray.tsx");
  const trayCode = await fs.readFile(trayPath, "utf8");
  if (!trayCode.includes('localStorage')) throw new Error("bottomtray_missing_localstorage");
}

function headers() {
  return {
    authorization: "Bearer admin",
    "x-tenant-id": "tenant_dev",
    "x-space-id": "space_dev",
    "x-user-locale": locale,
    "x-schema-name": "core",
  };
}

async function getHomeHtml() {
  const res = await fetch(`${webBase}/?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_home_failed:${res.status}`);
  return await res.text();
}

async function getSettingsHtml() {
  const res = await fetch(`${webBase}/settings?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_settings_failed:${res.status}`);
  return await res.text();
}

async function getRunsHtml() {
  const res = await fetch(`${webBase}/runs?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_runs_failed:${res.status}`);
  return await res.text();
}

async function getOrchestratorHtml() {
  const res = await fetch(`${webBase}/orchestrator?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_orchestrator_failed:${res.status}`);
  return await res.text();
}

async function getRunDetailHtml(runId) {
  const res = await fetch(`${webBase}/runs/${encodeURIComponent(runId)}?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_run_detail_failed:${res.status}`);
  return await res.text();
}

async function getGovChangeSetsHtml() {
  const res = await fetch(`${webBase}/gov/changesets?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_changesets_failed:${res.status}`);
  return await res.text();
}

async function getGovRoutingHtml() {
  const res = await fetch(`${webBase}/gov/routing?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_routing_failed:${res.status}`);
  return await res.text();
}

async function getGovAuditHtml() {
  const res = await fetch(`${webBase}/gov/audit?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_audit_failed:${res.status}`);
  return await res.text();
}

async function getGovToolsHtml() {
  const res = await fetch(`${webBase}/gov/tools?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_tools_failed:${res.status}`);
  return await res.text();
}

async function getGovWorkbenchesHtml() {
  const res = await fetch(`${webBase}/gov/workbenches?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_workbenches_failed:${res.status}`);
  return await res.text();
}

async function getGovUiPagesHtml() {
  const res = await fetch(`${webBase}/gov/ui-pages?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_ui_pages_failed:${res.status}`);
  return await res.text();
}

async function getGovModelsHtml() {
  const res = await fetch(`${webBase}/gov/models?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_models_failed:${res.status}`);
  return await res.text();
}

async function getGovArtifactPolicyHtml() {
  const res = await fetch(`${webBase}/gov/artifact-policy?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_artifact_policy_failed:${res.status}`);
  return await res.text();
}

async function getGovPolicySnapshotsHtml() {
  const res = await fetch(`${webBase}/gov/policy-snapshots?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_policy_snapshots_failed:${res.status}`);
  return await res.text();
}

async function getGovWorkflowDeadlettersHtml() {
  const res = await fetch(`${webBase}/gov/workflow/deadletters?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_workflow_deadletters_failed:${res.status}`);
  return await res.text();
}

async function getUiPageHtml(name) {
  const res = await fetch(`${webBase}/p/${encodeURIComponent(name)}?lang=${encodeURIComponent(locale)}`, {
    headers: { "cache-control": "no-cache", cookie: "openslin_token=admin" },
  });
  if (!res.ok) throw new Error(`web_p_page_failed:${res.status}`);
  return await res.text();
}

async function generatePageTemplates(entityName, pageKinds) {
  const res = await fetch(`${apiBase}/ui/page-templates/generate`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-ui-gen" },
    body: JSON.stringify({ schemaName: "core", entityName, pageKinds, overwriteStrategy: "overwrite_draft" }),
  });
  const json = await res.json().catch(() => null);
  if (res.status === 403) return null;
  if (!res.ok) throw new Error(`ui_generate_failed:${res.status}`);
  return json;
}

async function publishUiPage(name) {
  const res = await fetch(`${apiBase}/ui/pages/${encodeURIComponent(name)}/publish`, {
    method: "POST",
    headers: { ...headers(), "x-trace-id": "t-web-e2e-ui-publish" },
  });
  const json = await res.json().catch(() => null);
  if (res.status === 403) return null;
  if (!res.ok) throw new Error(`ui_publish_failed:${res.status}`);
  return json;
}

async function putViewPrefs(pageName, prefs) {
  const res = await fetch(`${apiBase}/ui/pages/${encodeURIComponent(pageName)}/view-prefs`, {
    method: "PUT",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-view-prefs-put" },
    body: JSON.stringify({ prefs }),
  });
  const json = await res.json().catch(() => null);
  if (res.status === 403) return null;
  if (!res.ok) throw new Error(`ui_view_prefs_put_failed:${res.status}`);
  return json;
}

async function deleteViewPrefs(pageName) {
  const res = await fetch(`${apiBase}/ui/pages/${encodeURIComponent(pageName)}/view-prefs`, {
    method: "DELETE",
    headers: { ...headers(), "x-trace-id": "t-web-e2e-view-prefs-del" },
  });
  const json = await res.json().catch(() => null);
  if (res.status === 403) return null;
  if (!res.ok) throw new Error(`ui_view_prefs_del_failed:${res.status}`);
  return json;
}

async function createChangeSet() {
  const res = await fetch(`${apiBase}/governance/changesets`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-cs-create" },
    body: JSON.stringify({ title: "web-e2e", scope: "space" }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`create_changeset_failed:${res.status}`);
  return json?.changeset?.id;
}

async function createRunId() {
  const res = await fetch(`${apiBase}/jobs/entities/notes/create`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "idempotency-key": crypto.randomUUID(), "x-trace-id": "t-web-e2e-run-create" },
    body: JSON.stringify({ title: "web-e2e" }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`create_run_failed:${res.status}`);
  return json?.runId;
}

async function orchestratorTurn(conversationId) {
  const res = await fetch(`${apiBase}/orchestrator/dispatch`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-orch-turn" },
    body: JSON.stringify({
      message: "搜索知识库 hello world",
      mode: "answer",
      locale,
      conversationId: conversationId ?? undefined,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`orchestrator_turn_failed:${res.status}`);
  return json;
}

async function orchestratorClearConversation(conversationId) {
  const res = await fetch(`${apiBase}/orchestrator/conversations/clear`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-orch-clear" },
    body: JSON.stringify({ conversationId }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`orchestrator_clear_failed:${res.status}`);
  return json;
}

async function publishKnowledgeSearchTool() {
  const res = await fetch(`${apiBase}/tools/knowledge.search/publish`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-tool-pub-knowledge-search" },
    body: JSON.stringify({
      scope: "read",
      resourceType: "knowledge",
      action: "search",
      idempotencyRequired: false,
      riskLevel: "low",
      approvalRequired: false,
      inputSchema: {
        fields: {
          query: { type: "string", required: true },
          limit: { type: "number", required: false },
        },
      },
      outputSchema: { fields: { results: { type: "json", required: false } } },
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`tool_publish_failed:${res.status}`);
  return json?.toolRef;
}

async function enableTool(toolRef) {
  const res = await fetch(`${apiBase}/governance/tools/${encodeURIComponent(toolRef)}/enable`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-tool-enable" },
    body: JSON.stringify({ scope: "space" }),
  });
  if (!res.ok) throw new Error(`tool_enable_failed:${res.status}`);
}

async function orchestratorExecute(turnId, suggestionId, input, idempotencyKey) {
  const res = await fetch(`${apiBase}/orchestrator/dispatch/execute`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json", "x-trace-id": "t-web-e2e-orch-execute" },
    body: JSON.stringify({ turnId, suggestionId, input, idempotencyKey }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`orchestrator_execute_failed:${res.status}`);
  return json;
}

async function getGovChangeSetDetailHtml(id) {
  const res = await fetch(`${webBase}/gov/changesets/${encodeURIComponent(id)}?lang=${encodeURIComponent(locale)}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`web_gov_changeset_detail_failed:${res.status}`);
  return await res.text();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function extractThead(html) {
  const m = /<thead>([\s\S]*?)<\/thead>/i.exec(html);
  return m?.[1] ?? "";
}

const html1 = await getHomeHtml();
assert(html1.includes("执行记录"), "expected_home_runs_link_visible");
assert(html1.includes("异步任务"), "expected_home_tasks_link_visible");
await assertHomeChatToolSuggestionsSupport();

/* ─── Five-State Architecture E2E Tests ─── */
console.log("[E2E] Validating Five-State Architecture components...");
await assertFiveStateArchitectureComponents();
console.log("[E2E] ✓ Five-State main components validated");
await assertBottomTraySubPanels();
console.log("[E2E] ✓ BottomTray sub-panels validated");
await assertArtifactPreviewTypes();
console.log("[E2E] ✓ ArtifactPreview types validated");
await assertWorkspaceTabDragAndDrop();
console.log("[E2E] ✓ Workspace Tab drag-and-drop validated");
await assertFlowItemRenderers();
console.log("[E2E] ✓ FlowItemRenderers validated");
console.log("[E2E] Five-State Architecture validation complete!");

/* ─── Critical Path Tests ─── */
console.log("[E2E] Validating critical path: Conversation → Task → Approval → Artifact → Workspace...");
await assertCriticalPathComponents();
console.log("[E2E] ✓ Critical path components validated");
await assertI18nCompleteness();
console.log("[E2E] ✓ i18n completeness validated");
await assertLocalStoragePersistence();
console.log("[E2E] ✓ LocalStorage persistence validated");

/* ─── Performance Baseline Tests ─── */
console.log("[E2E] Running performance baseline tests...");
const perfResult = await assertFirstScreenPerformance();
if (!perfResult.passed) {
  console.warn(`[E2E] ⚠ Performance baseline not met: ${perfResult.loadTime}ms > ${perfResult.baseline}ms`);
} else {
  console.log("[E2E] ✓ Performance baseline passed");
}
console.log("[E2E] All Five-State Architecture tests complete!");

const s1 = await getSettingsHtml();
assert(s1.includes(locale === "en-US" ? "Settings" : "设置"), "expected_settings_page_loads");
assert(s1.includes("模型绑定"), "expected_settings_has_model_binding_section");
assert(s1.includes("定时任务"), "expected_settings_has_schedules_section");
assert(s1.includes("通知"), "expected_settings_has_notifications_section");
assert(s1.includes("工作台"), "expected_settings_has_workbench_section");

const runId = await createRunId();
assert(runId, "expected_run_id_created");
const runsHtml = await getRunsHtml();
assert(runsHtml.includes("运行记录"), "expected_runs_page_loads");
const orchestratorHtml = await getOrchestratorHtml();
assert(orchestratorHtml.includes(locale === "en-US" ? "Orchestrator Playground" : "编排演示"), "expected_orchestrator_page_loads");
const runDetailHtml = await getRunDetailHtml(runId);
assert(runDetailHtml.includes("运行详情"), "expected_run_detail_page_loads");
assert(runDetailHtml.includes("回放"), "expected_run_replay_section_visible");
assert(runDetailHtml.includes("重执行"), "expected_run_reexec_action_visible");

const entityCreateRef = await publishKnowledgeSearchTool();
assert(entityCreateRef, "expected_knowledge_search_tool_published");
await enableTool(entityCreateRef);
const orchTurn0 = await orchestratorTurn();
assert(typeof orchTurn0.conversationId === "string" && orchTurn0.conversationId.length > 0, "expected_orchestrator_conversation_id");
await orchestratorClearConversation(orchTurn0.conversationId);
const orchTurn = await orchestratorTurn(orchTurn0.conversationId);
assert(orchTurn.conversationId === orchTurn0.conversationId, "expected_orchestrator_conversation_id_stable");
assert(orchTurn && orchTurn.turnId, "expected_orchestrator_turn_id");
assert(typeof orchTurn.replyText === "string" && orchTurn.replyText.length > 0, "expected_orchestrator_reply_text");
if (Array.isArray(orchTurn.toolSuggestions) && orchTurn.toolSuggestions.length > 0) {
  const s0 = orchTurn.toolSuggestions[0];
  assert(s0 && s0.suggestionId, "expected_orchestrator_suggestion_id");
  assert(s0 && s0.toolRef, "expected_orchestrator_suggestion_tool_ref");
  const orchExec = await orchestratorExecute(orchTurn.turnId, s0.suggestionId, s0.inputDraft, s0.idempotencyKey);
  assert(orchExec?.receipt?.status === "needs_approval" || orchExec?.receipt?.status === "queued", "expected_orchestrator_execute_status");
}

const govHtml = await getGovChangeSetsHtml();
assert(govHtml.includes("变更集"), "expected_gov_changesets_page_loads");

const routingHtml = await getGovRoutingHtml();
assert(routingHtml.includes("路由策略"), "expected_gov_routing_page_loads");

const auditHtml = await getGovAuditHtml();
assert(auditHtml.includes("审计"), "expected_gov_audit_page_loads");
assert(auditHtml.includes("Webhook"), "expected_gov_audit_has_webhook_section");
assert(auditHtml.includes(locale === "en-US" ? "Anomaly" : "异常"), "expected_gov_audit_has_anomaly_section");
assert(auditHtml.includes(locale === "en-US" ? "Export" : "导出"), "expected_gov_audit_has_export_section");

const toolsHtml = await getGovToolsHtml();
assert(typeof toolsHtml === "string" && toolsHtml.length > 0, "expected_gov_tools_page_loads");

const wbHtml = await getGovWorkbenchesHtml();
assert(typeof wbHtml === "string" && wbHtml.length > 0, "expected_gov_workbenches_page_loads");

const uiPagesHtml = await getGovUiPagesHtml();
assert(typeof uiPagesHtml === "string" && uiPagesHtml.length > 0, "expected_gov_ui_pages_page_loads");

const modelsHtml = await getGovModelsHtml();
assert(typeof modelsHtml === "string" && modelsHtml.length > 0, "expected_gov_models_page_loads");

const apHtml = await getGovArtifactPolicyHtml();
assert(typeof apHtml === "string" && apHtml.length > 0, "expected_gov_artifact_policy_page_loads");

const psHtml = await getGovPolicySnapshotsHtml();
assert(typeof psHtml === "string" && psHtml.length > 0, "expected_gov_policy_snapshots_page_loads");

const dlqHtml = await getGovWorkflowDeadlettersHtml();
assert(typeof dlqHtml === "string" && dlqHtml.length > 0, "expected_gov_workflow_deadletters_page_loads");

const csId = await createChangeSet();
const csDetailHtml = await getGovChangeSetDetailHtml(csId);
assert(typeof csDetailHtml === "string" && csDetailHtml.length > 0, "expected_changeset_detail_loads");

const generatedUiPage = await generatePageTemplates("notes", ["list"]);
if (generatedUiPage) {
  await publishUiPage("notes.list");
  await putViewPrefs("notes.list", { list: { columns: ["title"] } });
  const p1 = await getUiPageHtml("notes.list");
  const head1 = extractThead(p1);
  assert(head1.includes(locale === "en-US" ? "Title" : "标题"), "expected_notes_list_header_has_title");
  assert(!head1.includes(locale === "en-US" ? "Content" : "内容"), "expected_notes_list_header_not_has_content");

  await deleteViewPrefs("notes.list");
  const p2 = await getUiPageHtml("notes.list");
  const head2 = extractThead(p2);
  assert(head2.includes(locale === "en-US" ? "Content" : "内容"), "expected_notes_list_header_restored_has_content");
}
