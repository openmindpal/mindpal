-- 006: Workflow Engine
-- Consolidated from: 005, 022, 028(deadletter_retry), 029, 053, 054, 055, 056, 057, 058, 059(tenant col), 060, 061, 073, 091, 105, 144

-- ── jobs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  run_id UUID NULL,
  result_summary JSONB NULL,
  deadlettered_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_tenant_status_time_idx
  ON jobs (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS jobs_deadlettered_at_idx
  ON jobs (deadlettered_at DESC)
  WHERE deadlettered_at IS NOT NULL;

-- ── runs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL,
  policy_snapshot_ref TEXT NULL,
  tool_ref TEXT NULL,
  input_digest JSONB NULL,
  idempotency_key TEXT NULL,
  created_by_subject_id TEXT NULL,
  trigger TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  reexec_of_run_id UUID NULL REFERENCES runs(run_id),
  -- Sealed replay (from 105)
  sealed_at TIMESTAMPTZ NULL,
  sealed_schema_version INT NULL,
  sealed_input_digest JSONB NULL,
  sealed_output_digest JSONB NULL,
  nondeterminism_policy JSONB NULL,
  supply_chain JSONB NULL,
  isolation JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runs_tenant_status_time_idx
  ON runs (tenant_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_unique_idx
  ON runs (tenant_id, idempotency_key, tool_ref)
  WHERE idempotency_key IS NOT NULL AND tool_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_reexec_of_run_id_idx
  ON runs (reexec_of_run_id);

CREATE INDEX IF NOT EXISTS runs_tenant_policy_ref_idx
  ON runs (tenant_id, policy_snapshot_ref);

CREATE INDEX IF NOT EXISTS runs_tenant_sealed_at_idx
  ON runs (tenant_id, sealed_at DESC)
  WHERE sealed_at IS NOT NULL;

-- ── steps ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS steps (
  step_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(run_id),
  seq INT NOT NULL,
  status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  tool_ref TEXT NULL,
  input JSONB NULL,
  output JSONB NULL,
  error_category TEXT NULL,
  last_error TEXT NULL,
  input_digest JSONB NULL,
  output_digest JSONB NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  deadlettered_at TIMESTAMPTZ NULL,
  deadletter_retry_count INT NOT NULL DEFAULT 0,
  permanent_failure BOOLEAN NOT NULL DEFAULT false,
  last_error_digest JSONB NULL,
  queue_job_id TEXT NULL,
  -- Envelope encryption (from 057/058/061)
  input_enc_format TEXT NULL,
  input_key_version INT NULL,
  input_encrypted_payload JSONB NULL,
  output_enc_format TEXT NULL,
  output_key_version INT NULL,
  output_encrypted_payload JSONB NULL,
  compensation_enc_format TEXT NULL,
  compensation_key_version INT NULL,
  compensation_encrypted_payload JSONB NULL,
  policy_snapshot_ref TEXT NULL,
  -- Sealed replay (from 105)
  sealed_at TIMESTAMPTZ NULL,
  sealed_schema_version INT NULL,
  sealed_input_digest JSONB NULL,
  sealed_output_digest JSONB NULL,
  nondeterminism_policy JSONB NULL,
  supply_chain JSONB NULL,
  isolation JSONB NULL,
  -- Meta input (from 144)
  meta_input JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS steps_run_seq_idx
  ON steps (run_id, seq);

CREATE INDEX IF NOT EXISTS steps_deadlettered_at_idx
  ON steps (deadlettered_at DESC)
  WHERE deadlettered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS steps_run_tool_input_digest_idx
  ON steps (run_id, tool_ref, input_digest);

CREATE INDEX IF NOT EXISTS steps_run_sealed_at_idx
  ON steps (run_id, sealed_at DESC)
  WHERE sealed_at IS NOT NULL;

-- 死信重试扫描索引
CREATE INDEX IF NOT EXISTS steps_deadletter_retryable_idx
  ON steps (deadlettered_at ASC)
  WHERE deadlettered_at IS NOT NULL
    AND permanent_failure = false
    AND deadletter_retry_count < 3;

COMMENT ON COLUMN steps.meta_input IS '步骤执行元信息（JSON），如 actorRole, suggestionId 等非业务输入数据';

-- ── approvals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  run_id UUID NOT NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by_subject_id TEXT NOT NULL,
  policy_snapshot_ref TEXT NULL,
  input_digest JSONB NULL,
  tool_ref TEXT NULL,
  assessment_context JSONB DEFAULT NULL,
  decision TEXT NULL,
  reason TEXT NULL,
  decided_by_subject_id TEXT NULL,
  decided_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  escalated_at TIMESTAMPTZ NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN approvals.assessment_context
  IS '审批评估上下文 — 规则引擎输出的完整匹配结果（matchedRules/humanSummary/riskLevel 等），用于审批详情展示';

CREATE INDEX IF NOT EXISTS approvals_tenant_status_time_idx
  ON approvals (tenant_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS approvals_tenant_run_time_idx
  ON approvals (tenant_id, run_id, requested_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_pending_step_unique_idx
  ON approvals (tenant_id, step_id)
  WHERE step_id IS NOT NULL AND status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS approvals_pending_run_unique_idx
  ON approvals (tenant_id, run_id)
  WHERE step_id IS NULL AND status = 'pending';

-- ── approval_decisions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_decisions (
  decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES approvals(approval_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  decision TEXT NOT NULL,
  reason TEXT NULL,
  decided_by_subject_id TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_decisions_approval_time_idx
  ON approval_decisions (approval_id, decided_at DESC);

-- ── orchestrator_turns ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS orchestrator_turns (
  turn_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  message TEXT NOT NULL,
  tool_suggestions JSONB NULL,
  message_digest JSONB NULL,
  tool_suggestions_digest JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orchestrator_turns_tenant_space_time_idx
  ON orchestrator_turns (tenant_id, space_id, created_at DESC);

-- ── workflow_write_leases ────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_write_leases (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  owner_run_id TEXT NOT NULL,
  owner_step_id TEXT NOT NULL,
  owner_trace_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, resource_ref)
);

CREATE INDEX IF NOT EXISTS workflow_write_leases_expires_at_idx
  ON workflow_write_leases (expires_at);

-- ── trigger_definitions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS trigger_definitions (
  trigger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  cron_expr TEXT NULL,
  cron_tz TEXT NULL DEFAULT 'UTC',
  cron_misfire_policy TEXT NOT NULL DEFAULT 'skip',
  next_fire_at TIMESTAMPTZ NULL,
  event_source TEXT NULL,
  event_filter_json JSONB NULL,
  event_watermark_json JSONB NULL,
  target_kind TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  input_mapping_json JSONB NULL,
  idempotency_key_template TEXT NULL,
  idempotency_window_sec INT NOT NULL DEFAULT 3600,
  rate_limit_per_min INT NOT NULL DEFAULT 60,
  last_run_at TIMESTAMPTZ NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trigger_definitions_tenant_status_idx
  ON trigger_definitions (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS trigger_definitions_tenant_type_idx
  ON trigger_definitions (tenant_id, type, updated_at DESC);

CREATE INDEX IF NOT EXISTS trigger_definitions_next_fire_idx
  ON trigger_definitions (tenant_id, next_fire_at ASC)
  WHERE next_fire_at IS NOT NULL AND status = 'enabled' AND type = 'cron';

-- ── trigger_runs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trigger_runs (
  trigger_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  trigger_id UUID NOT NULL REFERENCES trigger_definitions(trigger_id),
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_at TIMESTAMPTZ NULL,
  fired_at TIMESTAMPTZ NULL,
  matched BOOLEAN NULL,
  match_reason TEXT NULL,
  match_digest JSONB NULL,
  idempotency_key TEXT NULL,
  event_ref_json JSONB NULL,
  job_id UUID NULL REFERENCES jobs(job_id),
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trigger_runs_trigger_time_idx
  ON trigger_runs (tenant_id, trigger_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS trigger_runs_dedupe_idx
  ON trigger_runs (trigger_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── workflow_step_compensations ──────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_step_compensations (
  compensation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  step_id UUID NOT NULL REFERENCES steps(step_id),
  compensation_job_id UUID NOT NULL REFERENCES jobs(job_id),
  compensation_run_id UUID NOT NULL REFERENCES runs(run_id),
  status TEXT NOT NULL DEFAULT 'queued',
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_step_compensations_step_time_idx
  ON workflow_step_compensations (tenant_id, step_id, created_at DESC);

-- (原033) Workflow Hardening
-- resume_events 幂等表、approvals 补充字段与过期扫描索引

-- ── resume_events（幂等恢复事件） ──────────────────────────────
CREATE TABLE IF NOT EXISTS resume_events (
  tenant_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, event_type, idempotency_key)
);

-- ── approvals 补充字段 ────────────────────────────────────────
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approval_type TEXT DEFAULT 'tool_execution';
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS escalation_minutes INT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS escalation_target TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS auto_reject_on_expiry BOOLEAN DEFAULT true;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS input_signature TEXT;

-- ── approvals 过期扫描索引 ────────────────────────────────────
CREATE INDEX IF NOT EXISTS approvals_expiry_scan_idx
  ON approvals (expires_at ASC)
  WHERE status = 'pending' AND expires_at IS NOT NULL;

-- ── resume_events 清理索引 ────────────────────────────────────
CREATE INDEX IF NOT EXISTS resume_events_created_idx
  ON resume_events (created_at ASC);
