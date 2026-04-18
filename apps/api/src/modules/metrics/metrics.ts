type CounterKey = string;

type HistogramKey = string;
type GaugeKey = string;

function keyOf(parts: Record<string, string>) {
  const keys = Object.keys(parts).sort();
  return keys.map((k) => `${k}=${parts[k]}`).join("|");
}

function escapeLabelValue(v: string) {
  return v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function renderLabels(labels: Record<string, string>) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const kv = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`).join(",");
  return `{${kv}}`;
}

type Histogram = {
  buckets: number[];
  bucketCounts: number[];
  count: number;
  sum: number;
};

export function createMetricsRegistry() {
  const startedAtMs = Date.now();
  const counters = new Map<CounterKey, { labels: Record<string, string>; value: number }>();
  const histograms = new Map<HistogramKey, { labels: Record<string, string>; h: Histogram }>();
  const gauges = new Map<GaugeKey, { labels: Record<string, string>; value: number }>();

  const durationBucketsMs = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const confidenceBuckets = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];

  function incCounter(name: string, labels: Record<string, string>, by = 1) {
    const k = `${name}|${keyOf(labels)}`;
    const cur = counters.get(k);
    if (cur) {
      cur.value += by;
      return;
    }
    counters.set(k, { labels: { ...labels, __name__: name }, value: by });
  }

  function observeHistogram(name: string, labels: Record<string, string>, value: number, buckets: number[]) {
    const k = `${name}|${keyOf(labels)}`;
    let cur = histograms.get(k);
    if (!cur) {
      cur = {
        labels: { ...labels, __name__: name },
        h: { buckets: [...buckets], bucketCounts: new Array(buckets.length + 1).fill(0), count: 0, sum: 0 },
      };
      histograms.set(k, cur);
    }
    cur.h.count += 1;
    cur.h.sum += value;
    let idx = buckets.findIndex((b) => value <= b);
    if (idx < 0) idx = buckets.length;
    cur.h.bucketCounts[idx] += 1;
  }

  function setGauge(name: string, labels: Record<string, string>, value: number) {
    const k = `${name}|${keyOf(labels)}`;
    const cur = gauges.get(k);
    if (cur) {
      cur.value = value;
      return;
    }
    gauges.set(k, { labels: { ...labels, __name__: name }, value });
  }

  function observeRequest(params: { method: string; route: string; statusCode: number; latencyMs: number }) {
    const statusClass = `${Math.floor(params.statusCode / 100)}xx`;
    incCounter("openslin_http_requests_total", { method: params.method, route: params.route, status_class: statusClass }, 1);
    observeHistogram("openslin_http_request_duration_ms", { method: params.method, route: params.route }, params.latencyMs, durationBucketsMs);
  }

  function incAuthzDenied(params: { resourceType: string; action: string }) {
    incCounter("openslin_authz_denied_total", { resource_type: params.resourceType, action: params.action }, 1);
  }

  function incAuditWriteFailed(params: { errorCode: string }) {
    incCounter("openslin_audit_write_failed_total", { error_code: params.errorCode }, 1);
  }

  function incAuditOutboxDispatch(params: { result: "ok" | "failed" }, by: number) {
    if (by <= 0) return;
    incCounter("openslin_audit_outbox_dispatch_total", { result: params.result }, by);
  }

  function incAuditOutboxEnqueue(params: { result: "ok" | "failed"; kind: string }) {
    incCounter("openslin_audit_outbox_enqueue_total", { result: params.result, kind: params.kind }, 1);
  }

  function setAuditOutboxBacklog(params: { status: string; count: number }) {
    setGauge("openslin_audit_outbox_backlog", { status: params.status }, params.count);
  }

  function incModelChat(params: { result: "success" | "denied" | "error" }) {
    incCounter("openslin_model_chat_total", { result: params.result }, 1);
  }

  function incModelCandidateSkipped(params: { reason: string }) {
    incCounter("openslin_model_chat_candidate_skipped_total", { reason: params.reason }, 1);
  }

  function incAgentPlanFailed(params: { runtime: "agent-runtime" | "collab-runtime"; category: string }) {
    incCounter("openslin_agent_plan_failed_total", { runtime: params.runtime, category: params.category }, 1);
  }

  function incAlertFired(params: { alert: string }) {
    incCounter("openslin_alert_fired_total", { alert: params.alert }, 1);
  }

  function incGovernancePipelineAction(params: { action: string; result: "ok" | "denied" | "error" }) {
    incCounter("openslin_governance_pipeline_actions_total", { action: params.action, result: params.result }, 1);
  }

  function incGovernanceGateFailed(params: { gateType: string }) {
    incCounter("openslin_governance_gate_failed_total", { gate_type: params.gateType }, 1);
  }

  function incEvalRun(params: { action: "enqueue" | "succeeded" | "failed" | "passed" | "not_passed" }) {
    incCounter("openslin_eval_run_total", { action: params.action }, 1);
  }

  function setWorkflowQueueBacklog(params: { status: string; count: number }) {
    setGauge("openslin_workflow_queue_backlog", { status: params.status }, params.count);
  }

  function setWorkerHeartbeatAgeSeconds(params: { worker: string; ageSeconds: number }) {
    setGauge("openslin_worker_heartbeat_age_seconds", { worker: params.worker }, params.ageSeconds);
  }

  function setWorkerWorkflowStepCount(params: { result: "success" | "error"; count: number }) {
    setGauge("openslin_worker_workflow_steps_processed", { result: params.result }, params.count);
  }

  function setWorkerToolExecuteCount(params: { result: "success" | "error"; count: number }) {
    setGauge("openslin_worker_tool_execute_processed", { result: params.result }, params.count);
  }

  function setCollabRunBacklog(params: { status: string; count: number }) {
    setGauge("openslin_collab_runs_backlog", { status: params.status }, params.count);
  }

  function setCollabEventCount1h(params: { type: string; count: number }) {
    setGauge("openslin_collab_events_1h_total", { type: params.type }, params.count);
  }

  function setCollabRunDurationAvgMs1h(params: { value: number }) {
    setGauge("openslin_collab_run_duration_ms_avg_1h", {}, params.value);
  }

  function setCollabStepsTotal(params: { actorRole: string; status: string; count: number }) {
    setGauge("openslin_collab_steps_total", { actor_role: params.actorRole, status: params.status }, params.count);
  }

  function setCollabBlockedTotal(params: { actorRole: string; reason: string; count: number }) {
    setGauge("openslin_collab_blocked_total", { actor_role: params.actorRole, reason: params.reason }, params.count);
  }

  function setCollabNeedsApprovalTotal(params: { actorRole: string; count: number }) {
    setGauge("openslin_collab_needs_approval_total", { actor_role: params.actorRole }, params.count);
  }

  function setCollabStepDurationBucket1h(params: { actorRole: string; le: string; count: number }) {
    setGauge("openslin_collab_step_duration_ms_bucket", { actor_role: params.actorRole, le: params.le }, params.count);
  }

  function setCollabStepDurationCount1h(params: { actorRole: string; count: number }) {
    setGauge("openslin_collab_step_duration_ms_count", { actor_role: params.actorRole }, params.count);
  }

  function setCollabStepDurationSumMs1h(params: { actorRole: string; sumMs: number }) {
    setGauge("openslin_collab_step_duration_ms_sum", { actor_role: params.actorRole }, params.sumMs);
  }

  function observeKnowledgeSearch(params: { result: "ok" | "denied" | "error"; latencyMs: number }) {
    incCounter("openslin_knowledge_search_total", { result: params.result }, 1);
    observeHistogram("openslin_knowledge_search_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
  }

  function observeKnowledgeEvidenceResolve(params: { result: "ok" | "denied" | "not_found" | "error"; latencyMs: number }) {
    incCounter("openslin_knowledge_evidence_resolve_total", { result: params.result }, 1);
    observeHistogram("openslin_knowledge_evidence_resolve_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
  }

  function observeSyncPush(params: { result: "ok" | "denied" | "error"; latencyMs: number; conflicts: number; deduped: number }) {
    incCounter("openslin_sync_push_total", { result: params.result }, 1);
    observeHistogram("openslin_sync_push_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
    incCounter("openslin_sync_push_conflicts_total", { result: params.result }, Math.max(0, params.conflicts));
    incCounter("openslin_sync_push_deduped_total", { result: params.result }, Math.max(0, params.deduped));
  }

  function observeSyncPull(params: { result: "ok" | "denied" | "error"; latencyMs: number; opsReturned: number }) {
    incCounter("openslin_sync_pull_total", { result: params.result }, 1);
    observeHistogram("openslin_sync_pull_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
    observeHistogram("openslin_sync_pull_ops_returned", { result: params.result }, params.opsReturned, [0, 1, 2, 5, 10, 20, 50, 100, 200, 500]);
  }

  /* ─── SSO/SCIM Metrics (Phase 3) ─── */

  function incSsoLogin(params: { provider_type: "oidc" | "saml"; result: "success" | "error"; tenant_id?: string }) {
    incCounter("openslin_sso_login_total", { provider_type: params.provider_type, result: params.result }, 1);
  }

  function observeSsoLoginLatency(params: { provider_type: "oidc" | "saml"; latencyMs: number }) {
    observeHistogram("openslin_sso_login_duration_ms", { provider_type: params.provider_type }, params.latencyMs, durationBucketsMs);
  }

  function incScimOperation(params: { operation: string; result: "success" | "error"; tenant_id?: string }) {
    incCounter("openslin_scim_operation_total", { operation: params.operation, result: params.result }, 1);
  }

  function setScimProvisionedUsers(params: { tenant_id: string; active: number; total: number }) {
    setGauge("openslin_scim_provisioned_users_active", { tenant_id: params.tenant_id }, params.active);
    setGauge("openslin_scim_provisioned_users_total", { tenant_id: params.tenant_id }, params.total);
  }

  function incDataIsolationViolation(params: { reason: string; tenant_id?: string }) {
    incCounter("openslin_data_isolation_violation_total", { reason: params.reason }, 1);
  }

  /* ─── Health Check Metrics ─── */

  function setHealthStatus(params: { component: string; healthy: boolean }) {
    setGauge("openslin_health_status", { component: params.component }, params.healthy ? 1 : 0);
  }

  function setDatabasePoolStats(params: { idle: number; total: number; waiting: number }) {
    setGauge("openslin_db_pool_idle", {}, params.idle);
    setGauge("openslin_db_pool_total", {}, params.total);
    setGauge("openslin_db_pool_waiting", {}, params.waiting);
  }

  /* ─── P3-1: Intent Analyzer Metrics ─── */

  function observeIntentAnalysis(params: { result: "ok" | "denied" | "error" | "llm_fallback"; latencyMs: number; usedLLM: boolean }) {
    incCounter("openslin_intent_analysis_total", { result: params.result, used_llm: String(params.usedLLM) }, 1);
    observeHistogram("openslin_intent_analysis_duration_ms", { result: params.result, used_llm: String(params.usedLLM) }, params.latencyMs, durationBucketsMs);
  }

  function incIntentRuleMatch(params: { ruleId: string; confidence: "high" | "medium" | "low" }) {
    incCounter("openslin_intent_rule_matches_total", { rule_id: params.ruleId, confidence: params.confidence }, 1);
  }

  /* ─── P0-1: Unified Intent Route Metrics (orchestrator 主入口统一口径) ─── */

  function observeIntentRoute(params: {
    source: "dispatch" | "dispatch.stream" | "dispatch.classify" | "dispatch_shadow";
    classifier: "fast" | "llm" | "two_level" | "parallel_fast" | "reviewer";
    mode: string;
    confidence: number;
    result: "ok" | "error" | "fallback" | "shadow_agree" | "shadow_disagree";
    latencyMs: number;
    selectedMode?: string;
    autoDowngraded?: boolean;
  }) {
    incCounter("openslin_orchestrator_intent_route_total", {
      source: params.source,
      classifier: params.classifier,
      mode: params.mode,
      result: params.result,
      selected_mode: params.selectedMode ?? params.mode,
      auto_downgraded: String(params.autoDowngraded ?? false),
    }, 1);
    observeHistogram("openslin_orchestrator_intent_route_duration_ms", {
      source: params.source,
      classifier: params.classifier,
      result: params.result,
    }, params.latencyMs, durationBucketsMs);
    observeHistogram("openslin_orchestrator_intent_confidence", {
      source: params.source,
      classifier: params.classifier,
      mode: params.mode,
    }, params.confidence, confidenceBuckets);
  }

  /* ─── P0-2: Goal Decompose Metrics ─── */

  function observeGoalDecompose(params: {
    result: "ok" | "fallback" | "error" | "disabled";
    latencyMs: number;
    subGoalCount: number;
    strategy?: "early_exit" | "template" | "fast_model" | "standard_model" | "single_node" | "disabled";
  }) {
    incCounter("openslin_goal_decompose_total", {
      result: params.result,
      strategy: params.strategy ?? "standard_model",
    }, 1);
    observeHistogram("openslin_goal_decompose_duration_ms", {
      result: params.result,
    }, params.latencyMs, durationBucketsMs);
    if (params.result === "fallback" || params.result === "error") {
      incCounter("openslin_goal_decompose_fallback_total", { result: params.result }, 1);
    }
  }

  /* ─── P0-2: Planning Pipeline Metrics ─── */

  function observePlanningPipeline(params: {
    result: "ok" | "error" | "no_tools" | "no_enabled_suggestion" | "empty";
    latencyMs: number;
    stepCount: number;
    droppedCount: number;
    semanticRouteUsed: boolean;
  }) {
    incCounter("openslin_planning_pipeline_total", {
      result: params.result,
      semantic_route: String(params.semanticRouteUsed),
    }, 1);
    observeHistogram("openslin_planning_pipeline_duration_ms", {
      result: params.result,
    }, params.latencyMs, durationBucketsMs);
  }

  /* ─── P0-2: Agent Decision (think/decide) Metrics ─── */

  function observeAgentDecision(params: {
    result: "ok" | "error" | "timeout";
    decision: "tool_call" | "done" | "yield" | "replan" | "error";
    latencyMs: number;
    iterationSeq: number;
  }) {
    incCounter("openslin_agent_decision_total", {
      result: params.result,
      decision: params.decision,
    }, 1);
    observeHistogram("openslin_agent_decision_duration_ms", {
      result: params.result,
      decision: params.decision,
    }, params.latencyMs, durationBucketsMs);
  }

  /* ─── P0-2: Parallel Tool Calls Metrics ─── */

  function observeParallelToolCalls(params: {
    result: "ok" | "partial" | "error";
    latencyMs: number;
    parallelCount: number;
    successCount: number;
    failedCount: number;
  }) {
    incCounter("openslin_parallel_tool_calls_total", {
      result: params.result,
    }, 1);
    observeHistogram("openslin_parallel_tool_calls_duration_ms", {
      result: params.result,
    }, params.latencyMs, durationBucketsMs);
  }

  /* ─── P2-9 / P4-2: Plan Quality Metrics ─── */

  function observePlanQualityScore(params: {
    score: number;
    dagValid: boolean;
    repairApplied: boolean;
  }) {
    observeHistogram("openslin_plan_quality_score", {
      dag_valid: String(params.dagValid),
      repair_applied: String(params.repairApplied),
    }, params.score, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
    if (params.repairApplied) {
      incCounter("openslin_plan_semantic_repair_total", {}, 1);
    }
  }

  /* ─── P3-1: Orchestrator Metrics ─── */

  function observeOrchestratorExecution(params: { result: "ok" | "denied" | "error" | "timeout"; latencyMs: number; toolType?: string }) {
    incCounter("openslin_orchestrator_execution_total", { result: params.result, tool_type: params.toolType ?? "unknown" }, 1);
    observeHistogram("openslin_orchestrator_execution_duration_ms", { result: params.result, tool_type: params.toolType ?? "unknown" }, params.latencyMs, durationBucketsMs);
  }

  function incOrchestratorToolCall(params: { toolRef: string; result: "success" | "failed" | "timeout" }) {
    incCounter("openslin_orchestrator_tool_calls_total", { tool_ref: params.toolRef, result: params.result }, 1);
  }

  function setOrchestratorActiveRuns(params: { count: number }) {
    setGauge("openslin_orchestrator_active_runs", {}, params.count);
  }

  /* ─── P3-1: Device Runtime Metrics ─── */

  function observeDeviceExecution(params: { result: "ok" | "denied" | "error" | "timeout"; latencyMs: number; deviceType?: string }) {
    incCounter("openslin_device_execution_total", { result: params.result, device_type: params.deviceType ?? "unknown" }, 1);
    observeHistogram("openslin_device_execution_duration_ms", { result: params.result, device_type: params.deviceType ?? "unknown" }, params.latencyMs, durationBucketsMs);
  }

  function incDeviceMessage(params: { category: string; result: "delivered" | "failed" | "dropped" }) {
    incCounter("openslin_device_messages_total", { category: params.category, result: params.result }, 1);
  }

  function setDeviceConnectedClients(params: { count: number }) {
    setGauge("openslin_device_connected_clients", {}, params.count);
  }

  function incDevicePushNotification(params: { method: "cross_device_bus" | "local_ws"; result: "ok" | "failed" }) {
    incCounter("openslin_device_push_notifications_total", { method: params.method, result: params.result }, 1);
  }

  /* ─── P3-13: Eval Gate Metrics ─── */

  function incEvalGateBlocked(params: { reason: "missing" | "stale" | "failed" | "running" | "threshold_not_met" | "category_threshold_not_met" }) {
    incCounter("openslin_eval_gate_blocked_total", { reason: params.reason }, 1);
  }

  function observeEvalGateCheck(params: { result: "passed" | "blocked"; suiteCount: number; latencyMs: number }) {
    incCounter("openslin_eval_gate_check_total", { result: params.result }, 1);
    observeHistogram("openslin_eval_gate_check_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
    setGauge("openslin_eval_gate_suite_count", {}, params.suiteCount);
  }

  /* ─── P3-13: Debate Session Metrics ─── */

  function incDebateSession(params: { result: "consensus" | "deadlock" | "timeout" | "arbitrated" }) {
    incCounter("openslin_debate_sessions_total", { result: params.result }, 1);
  }

  function observeDebateDuration(params: { result: string; latencyMs: number }) {
    observeHistogram("openslin_debate_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
  }

  function incDebateRound(params: { sessionId?: string }) {
    incCounter("openslin_debate_rounds_total", {}, 1);
  }

  /* ─── P3-13: Conflict Resolution Metrics ─── */

  function incConflictResolution(params: { strategy: string }) {
    incCounter("openslin_conflict_resolution_total", { strategy: params.strategy }, 1);
  }

  function incConflictManualRequired() {
    incCounter("openslin_conflict_manual_required_total", {}, 1);
  }

  function observeConflictBatch(params: { totalFields: number; conflictedFields: number; autoResolved: number }) {
    setGauge("openslin_conflict_batch_fields_total", {}, params.totalFields);
    setGauge("openslin_conflict_batch_conflicted", {}, params.conflictedFields);
    setGauge("openslin_conflict_batch_auto_resolved", {}, params.autoResolved);
  }

  /* ─── P3-13: Output Quality Eval Metrics ─── */

  function observeOutputQuality(params: { dimension: "schema" | "confidence" | "hallucination"; passed: boolean; score: number }) {
    incCounter("openslin_output_quality_check_total", { dimension: params.dimension, passed: String(params.passed) }, 1);
    observeHistogram("openslin_output_quality_score", { dimension: params.dimension }, params.score, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
  }

  function renderPrometheus() {
    const lines: string[] = [];

    const uptimeSec = (Date.now() - startedAtMs) / 1000;
    lines.push("# HELP openslin_process_uptime_seconds Process uptime in seconds.");
    lines.push("# TYPE openslin_process_uptime_seconds gauge");
    lines.push(`openslin_process_uptime_seconds ${uptimeSec.toFixed(3)}`);

    lines.push("# HELP openslin_http_requests_total Total HTTP requests.");
    lines.push("# TYPE openslin_http_requests_total counter");

    lines.push("# HELP openslin_http_request_duration_ms HTTP request duration in milliseconds.");
    lines.push("# TYPE openslin_http_request_duration_ms histogram");

    lines.push("# HELP openslin_authz_denied_total Total authorization denials.");
    lines.push("# TYPE openslin_authz_denied_total counter");

    lines.push("# HELP openslin_audit_write_failed_total Total audit write failures.");
    lines.push("# TYPE openslin_audit_write_failed_total counter");

    lines.push("# HELP openslin_audit_outbox_dispatch_total Total outbox dispatch results.");
    lines.push("# TYPE openslin_audit_outbox_dispatch_total counter");

    lines.push("# HELP openslin_audit_outbox_enqueue_total Total outbox enqueue results.");
    lines.push("# TYPE openslin_audit_outbox_enqueue_total counter");

    lines.push("# HELP openslin_audit_outbox_backlog Audit outbox backlog by status.");
    lines.push("# TYPE openslin_audit_outbox_backlog gauge");

    lines.push("# HELP openslin_model_chat_total Total model chat calls by result.");
    lines.push("# TYPE openslin_model_chat_total counter");

    lines.push("# HELP openslin_model_chat_candidate_skipped_total Total skipped model candidates by reason.");
    lines.push("# TYPE openslin_model_chat_candidate_skipped_total counter");

    lines.push("# HELP openslin_governance_pipeline_actions_total Total governance pipeline actions.");
    lines.push("# TYPE openslin_governance_pipeline_actions_total counter");

    lines.push("# HELP openslin_governance_gate_failed_total Total governance gate failures.");
    lines.push("# TYPE openslin_governance_gate_failed_total counter");

    lines.push("# HELP openslin_workflow_queue_backlog Workflow queue backlog by status.");
    lines.push("# TYPE openslin_workflow_queue_backlog gauge");

    lines.push("# HELP openslin_worker_heartbeat_age_seconds Worker heartbeat age in seconds.");
    lines.push("# TYPE openslin_worker_heartbeat_age_seconds gauge");

    lines.push("# HELP openslin_worker_workflow_steps_processed Worker processed workflow steps (gauge snapshot).");
    lines.push("# TYPE openslin_worker_workflow_steps_processed gauge");

    lines.push("# HELP openslin_worker_tool_execute_processed Worker processed tool executions (gauge snapshot).");
    lines.push("# TYPE openslin_worker_tool_execute_processed gauge");

    lines.push("# HELP openslin_collab_runs_backlog Collab run backlog by status.");
    lines.push("# TYPE openslin_collab_runs_backlog gauge");

    lines.push("# HELP openslin_collab_events_1h_total Collab events count in last hour.");
    lines.push("# TYPE openslin_collab_events_1h_total gauge");

    lines.push("# HELP openslin_collab_run_duration_ms_avg_1h Average collab run duration in ms (last hour).");
    lines.push("# TYPE openslin_collab_run_duration_ms_avg_1h gauge");

    lines.push("# HELP openslin_collab_steps_total Collab steps count by actor role and status (snapshot).");
    lines.push("# TYPE openslin_collab_steps_total gauge");

    lines.push("# HELP openslin_collab_blocked_total Collab blocked events by actor role and reason (snapshot).");
    lines.push("# TYPE openslin_collab_blocked_total gauge");

    lines.push("# HELP openslin_collab_needs_approval_total Collab needs approval events by actor role (snapshot).");
    lines.push("# TYPE openslin_collab_needs_approval_total gauge");

    lines.push("# HELP openslin_collab_step_duration_ms_bucket Collab step duration histogram buckets in ms (snapshot).");
    lines.push("# TYPE openslin_collab_step_duration_ms_bucket gauge");

    lines.push("# HELP openslin_collab_step_duration_ms_count Collab step duration histogram count (snapshot).");
    lines.push("# TYPE openslin_collab_step_duration_ms_count gauge");

    lines.push("# HELP openslin_collab_step_duration_ms_sum Collab step duration histogram sum in ms (snapshot).");
    lines.push("# TYPE openslin_collab_step_duration_ms_sum gauge");

    lines.push("# HELP openslin_knowledge_search_total Total knowledge search calls by result.");
    lines.push("# TYPE openslin_knowledge_search_total counter");

    lines.push("# HELP openslin_knowledge_search_duration_ms Knowledge search duration in milliseconds.");
    lines.push("# TYPE openslin_knowledge_search_duration_ms histogram");

    lines.push("# HELP openslin_knowledge_evidence_resolve_total Total evidence resolve calls by result.");
    lines.push("# TYPE openslin_knowledge_evidence_resolve_total counter");

    lines.push("# HELP openslin_knowledge_evidence_resolve_duration_ms Evidence resolve duration in milliseconds.");
    lines.push("# TYPE openslin_knowledge_evidence_resolve_duration_ms histogram");

    lines.push("# HELP openslin_sync_push_total Total sync push calls by result.");
    lines.push("# TYPE openslin_sync_push_total counter");

    lines.push("# HELP openslin_sync_push_duration_ms Sync push duration in milliseconds.");
    lines.push("# TYPE openslin_sync_push_duration_ms histogram");

    lines.push("# HELP openslin_sync_push_conflicts_total Total sync push conflicts by result.");
    lines.push("# TYPE openslin_sync_push_conflicts_total counter");

    lines.push("# HELP openslin_sync_push_deduped_total Total sync push deduped ops by result.");
    lines.push("# TYPE openslin_sync_push_deduped_total counter");

    lines.push("# HELP openslin_sync_pull_total Total sync pull calls by result.");
    lines.push("# TYPE openslin_sync_pull_total counter");

    lines.push("# HELP openslin_sync_pull_duration_ms Sync pull duration in milliseconds.");
    lines.push("# TYPE openslin_sync_pull_duration_ms histogram");

    lines.push("# HELP openslin_sync_pull_ops_returned Ops returned by sync pull.");
    lines.push("# TYPE openslin_sync_pull_ops_returned histogram");

    lines.push("# HELP openslin_sso_login_total Total SSO login attempts by provider type and result.");
    lines.push("# TYPE openslin_sso_login_total counter");

    lines.push("# HELP openslin_sso_login_duration_ms SSO login duration in milliseconds.");
    lines.push("# TYPE openslin_sso_login_duration_ms histogram");

    lines.push("# HELP openslin_scim_operation_total Total SCIM operations by type and result.");
    lines.push("# TYPE openslin_scim_operation_total counter");

    lines.push("# HELP openslin_scim_provisioned_users_active Number of active SCIM provisioned users.");
    lines.push("# TYPE openslin_scim_provisioned_users_active gauge");

    lines.push("# HELP openslin_scim_provisioned_users_total Total number of SCIM provisioned users.");
    lines.push("# TYPE openslin_scim_provisioned_users_total gauge");

    lines.push("# HELP openslin_data_isolation_violation_total Total data isolation violations.");
    lines.push("# TYPE openslin_data_isolation_violation_total counter");

    lines.push("# HELP openslin_health_status Component health status (1=healthy, 0=unhealthy).");
    lines.push("# TYPE openslin_health_status gauge");

    lines.push("# HELP openslin_db_pool_idle Number of idle database pool connections.");
    lines.push("# TYPE openslin_db_pool_idle gauge");

    lines.push("# HELP openslin_db_pool_total Total database pool connections.");
    lines.push("# TYPE openslin_db_pool_total gauge");

    lines.push("# HELP openslin_db_pool_waiting Number of waiting database pool requests.");
    lines.push("# TYPE openslin_db_pool_waiting gauge");

    // P3-1: Intent Analyzer Metrics HELP
    lines.push("# HELP openslin_intent_analysis_total Total intent analysis operations.");
    lines.push("# TYPE openslin_intent_analysis_total counter");

    lines.push("# HELP openslin_intent_analysis_duration_ms Intent analysis duration in milliseconds.");
    lines.push("# TYPE openslin_intent_analysis_duration_ms histogram");

    lines.push("# HELP openslin_intent_rule_matches_total Total intent rule matches by confidence.");
    lines.push("# TYPE openslin_intent_rule_matches_total counter");

    // P0-1: Unified Intent Route Metrics HELP
    lines.push("# HELP openslin_orchestrator_intent_route_total Unified intent route total (covers dispatch + stream + classify).");
    lines.push("# TYPE openslin_orchestrator_intent_route_total counter");
    lines.push("# HELP openslin_orchestrator_intent_route_duration_ms Intent route classification duration in ms.");
    lines.push("# TYPE openslin_orchestrator_intent_route_duration_ms histogram");

    // P0-2: Goal Decompose Metrics HELP
    lines.push("# HELP openslin_goal_decompose_total Total goal decomposition operations.");
    lines.push("# TYPE openslin_goal_decompose_total counter");
    lines.push("# HELP openslin_goal_decompose_duration_ms Goal decomposition duration in ms.");
    lines.push("# TYPE openslin_goal_decompose_duration_ms histogram");
    lines.push("# HELP openslin_goal_decompose_fallback_total Total goal decomposition fallbacks.");
    lines.push("# TYPE openslin_goal_decompose_fallback_total counter");

    // P0-2: Planning Pipeline Metrics HELP
    lines.push("# HELP openslin_planning_pipeline_total Total planning pipeline executions.");
    lines.push("# TYPE openslin_planning_pipeline_total counter");
    lines.push("# HELP openslin_planning_pipeline_duration_ms Planning pipeline duration in ms.");
    lines.push("# TYPE openslin_planning_pipeline_duration_ms histogram");

    // P0-2: Agent Decision Metrics HELP
    lines.push("# HELP openslin_agent_decision_total Total agent think-decide iterations.");
    lines.push("# TYPE openslin_agent_decision_total counter");
    lines.push("# HELP openslin_agent_decision_duration_ms Agent decision duration in ms.");
    lines.push("# TYPE openslin_agent_decision_duration_ms histogram");

    // P0-2: Parallel Tool Calls Metrics HELP
    lines.push("# HELP openslin_parallel_tool_calls_total Total parallel tool call batches.");
    lines.push("# TYPE openslin_parallel_tool_calls_total counter");
    lines.push("# HELP openslin_parallel_tool_calls_duration_ms Parallel tool calls batch duration in ms.");
    lines.push("# TYPE openslin_parallel_tool_calls_duration_ms histogram");

    // P2-9 / P4-2: Plan Quality Metrics HELP
    lines.push("# HELP openslin_plan_quality_score Plan quality score distribution.");
    lines.push("# TYPE openslin_plan_quality_score histogram");
    lines.push("# HELP openslin_plan_semantic_repair_total Total plan semantic repairs.");
    lines.push("# TYPE openslin_plan_semantic_repair_total counter");

    // P3-1: Orchestrator Metrics HELP
    lines.push("# HELP openslin_orchestrator_execution_total Total orchestrator executions.");
    lines.push("# TYPE openslin_orchestrator_execution_total counter");

    lines.push("# HELP openslin_orchestrator_execution_duration_ms Orchestrator execution duration in milliseconds.");
    lines.push("# TYPE openslin_orchestrator_execution_duration_ms histogram");

    lines.push("# HELP openslin_orchestrator_tool_calls_total Total orchestrator tool calls.");
    lines.push("# TYPE openslin_orchestrator_tool_calls_total counter");

    lines.push("# HELP openslin_orchestrator_active_runs Current number of active orchestrator runs.");
    lines.push("# TYPE openslin_orchestrator_active_runs gauge");

    // P3-1: Device Runtime Metrics HELP
    lines.push("# HELP openslin_device_execution_total Total device executions.");
    lines.push("# TYPE openslin_device_execution_total counter");

    lines.push("# HELP openslin_device_execution_duration_ms Device execution duration in milliseconds.");
    lines.push("# TYPE openslin_device_execution_duration_ms histogram");

    lines.push("# HELP openslin_device_messages_total Total device messages by category.");
    lines.push("# TYPE openslin_device_messages_total counter");

    lines.push("# HELP openslin_device_connected_clients Number of connected device clients.");
    lines.push("# TYPE openslin_device_connected_clients gauge");

    lines.push("# HELP openslin_device_push_notifications_total Total device push notifications.");
    lines.push("# TYPE openslin_device_push_notifications_total counter");

    // P3-13: Eval Gate Metrics
    lines.push("# HELP openslin_eval_gate_blocked_total Total eval gate blocks by reason.");
    lines.push("# TYPE openslin_eval_gate_blocked_total counter");
    lines.push("# HELP openslin_eval_gate_check_total Total eval gate checks.");
    lines.push("# TYPE openslin_eval_gate_check_total counter");
    lines.push("# HELP openslin_eval_gate_check_duration_ms Eval gate check duration in ms.");
    lines.push("# TYPE openslin_eval_gate_check_duration_ms histogram");
    lines.push("# HELP openslin_eval_gate_suite_count Number of suites in last eval gate check.");
    lines.push("# TYPE openslin_eval_gate_suite_count gauge");

    // P3-13: Debate Metrics
    lines.push("# HELP openslin_debate_sessions_total Total debate sessions by result.");
    lines.push("# TYPE openslin_debate_sessions_total counter");
    lines.push("# HELP openslin_debate_duration_ms Debate session duration in ms.");
    lines.push("# TYPE openslin_debate_duration_ms histogram");
    lines.push("# HELP openslin_debate_rounds_total Total debate rounds.");
    lines.push("# TYPE openslin_debate_rounds_total counter");

    // P3-13: Conflict Resolution Metrics
    lines.push("# HELP openslin_conflict_resolution_total Total conflict resolutions by strategy.");
    lines.push("# TYPE openslin_conflict_resolution_total counter");
    lines.push("# HELP openslin_conflict_manual_required_total Total conflicts requiring manual resolution.");
    lines.push("# TYPE openslin_conflict_manual_required_total counter");
    lines.push("# HELP openslin_conflict_batch_fields_total Fields processed in last conflict batch.");
    lines.push("# TYPE openslin_conflict_batch_fields_total gauge");
    lines.push("# HELP openslin_conflict_batch_conflicted Conflicted fields in last batch.");
    lines.push("# TYPE openslin_conflict_batch_conflicted gauge");
    lines.push("# HELP openslin_conflict_batch_auto_resolved Auto-resolved fields in last batch.");
    lines.push("# TYPE openslin_conflict_batch_auto_resolved gauge");

    // P3-13: Output Quality Metrics
    lines.push("# HELP openslin_output_quality_check_total Total output quality checks.");
    lines.push("# TYPE openslin_output_quality_check_total counter");
    lines.push("# HELP openslin_output_quality_score Output quality score distribution.");
    lines.push("# TYPE openslin_output_quality_score histogram");

    for (const v of counters.values()) {
      const { __name__, ...labels } = v.labels as any;
      lines.push(`${__name__}${renderLabels(labels)} ${v.value}`);
    }

    for (const v of gauges.values()) {
      const { __name__, ...labels } = v.labels as any;
      lines.push(`${__name__}${renderLabels(labels)} ${v.value}`);
    }

    for (const v of histograms.values()) {
      const { __name__, ...labels } = v.labels as any;
      let cumulative = 0;
      for (let i = 0; i < v.h.bucketCounts.length; i++) {
        cumulative += v.h.bucketCounts[i] ?? 0;
        const le = i < v.h.buckets.length ? String(v.h.buckets[i]) : "+Inf";
        lines.push(`${__name__}_bucket${renderLabels({ ...labels, le })} ${cumulative}`);
      }
      lines.push(`${__name__}_count${renderLabels(labels)} ${v.h.count}`);
      lines.push(`${__name__}_sum${renderLabels(labels)} ${v.h.sum.toFixed(3)}`);
    }

    return lines.join("\n") + "\n";
  }

  return {
    observeRequest,
    incAuthzDenied,
    incAuditWriteFailed,
    incAuditOutboxDispatch,
    incAuditOutboxEnqueue,
    setAuditOutboxBacklog,
    incModelChat,
    incModelCandidateSkipped,
    incAgentPlanFailed,
    incGovernancePipelineAction,
    incGovernanceGateFailed,
    incEvalRun,
    setWorkflowQueueBacklog,
    setWorkerHeartbeatAgeSeconds,
    setWorkerWorkflowStepCount,
    setWorkerToolExecuteCount,
    setCollabRunBacklog,
    setCollabEventCount1h,
    setCollabRunDurationAvgMs1h,
    setCollabStepsTotal,
    setCollabBlockedTotal,
    setCollabNeedsApprovalTotal,
    setCollabStepDurationBucket1h,
    setCollabStepDurationCount1h,
    setCollabStepDurationSumMs1h,
    observeKnowledgeSearch,
    observeKnowledgeEvidenceResolve,
    observeSyncPush,
    observeSyncPull,
    incAlertFired,
    incSsoLogin,
    observeSsoLoginLatency,
    incScimOperation,
    setScimProvisionedUsers,
    incDataIsolationViolation,
    setHealthStatus,
    setDatabasePoolStats,
    // P3-1: Intent Analyzer Metrics
    observeIntentAnalysis,
    incIntentRuleMatch,
    // P0-1: Unified Intent Route Metrics
    observeIntentRoute,
    // P0-2: Goal Decompose / Planning / Agent Decision / Parallel Tool Calls
    observeGoalDecompose,
    observePlanningPipeline,
    observeAgentDecision,
    observeParallelToolCalls,
    // P2-9 / P4-2: Plan Quality
    observePlanQualityScore,
    // P3-1: Orchestrator Metrics
    observeOrchestratorExecution,
    incOrchestratorToolCall,
    setOrchestratorActiveRuns,
    // P3-1: Device Runtime Metrics
    observeDeviceExecution,
    incDeviceMessage,
    setDeviceConnectedClients,
    incDevicePushNotification,
    // P3-13: Eval Gate Metrics
    incEvalGateBlocked,
    observeEvalGateCheck,
    // P3-13: Debate Metrics
    incDebateSession,
    observeDebateDuration,
    incDebateRound,
    // P3-13: Conflict Resolution Metrics
    incConflictResolution,
    incConflictManualRequired,
    observeConflictBatch,
    // P3-13: Output Quality Metrics
    observeOutputQuality,
    renderPrometheus,
  };
}

export type MetricsRegistry = ReturnType<typeof createMetricsRegistry>;
