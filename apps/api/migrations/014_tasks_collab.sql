-- 014: Tasks & Multi-Agent Collaboration
-- Consolidated from: 030, 079, 100, 113, 139, 142, 155

-- ── tasks ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  created_by_subject_id TEXT NOT NULL,
  title TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_tenant_space_time_idx
  ON tasks (tenant_id, space_id, created_at DESC);

-- ── agent_messages ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  from_agent_id TEXT NULL,
  from_role TEXT NOT NULL,
  intent TEXT NOT NULL,
  correlation JSONB NULL,
  inputs JSONB NULL,
  outputs JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_messages_task_time_idx
  ON agent_messages (task_id, created_at DESC);

-- ── collab_runs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_runs (
  collab_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  created_by_subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  roles_json JSONB NULL,
  limits_json JSONB NULL,
  primary_run_id UUID NULL REFERENCES runs(run_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_runs_tenant_space_time_idx ON collab_runs (tenant_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_runs_task_time_idx ON collab_runs (task_id, created_at DESC);

-- ── collab_run_events ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_run_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  collab_run_id UUID NOT NULL REFERENCES collab_runs(collab_run_id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  type TEXT NOT NULL,
  actor_role TEXT NULL,
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  payload_digest JSONB NULL,
  policy_snapshot_ref TEXT NULL,
  correlation_id TEXT NULL,
  -- Responsibility chain (from 142)
  proposed_by TEXT NULL,
  executed_by TEXT NULL,
  reviewed_by TEXT NULL,
  approved_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_run_events_run_time_idx ON collab_run_events (collab_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_run_events_run_corr_time_idx ON collab_run_events (collab_run_id, correlation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_run_events_task_time_idx ON collab_run_events (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collab_run_events_proposed_by ON collab_run_events(tenant_id, proposed_by) WHERE proposed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_run_events_executed_by ON collab_run_events(tenant_id, executed_by) WHERE executed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_run_events_approved_by ON collab_run_events(tenant_id, approved_by) WHERE approved_by IS NOT NULL;

-- ── collab_envelopes ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_envelopes (
  envelope_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  collab_run_id UUID NOT NULL REFERENCES collab_runs(collab_run_id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  from_role TEXT NOT NULL,
  to_role TEXT NULL,
  broadcast BOOLEAN NOT NULL DEFAULT false,
  kind TEXT NOT NULL,
  correlation_id TEXT NULL,
  policy_snapshot_ref TEXT NULL,
  payload_digest JSONB NOT NULL,
  payload_redacted JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_envelopes_run_time_idx ON collab_envelopes (collab_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_envelopes_run_to_time_idx ON collab_envelopes (collab_run_id, to_role, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_envelopes_run_from_time_idx ON collab_envelopes (collab_run_id, from_role, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_envelopes_run_corr_time_idx ON collab_envelopes (collab_run_id, correlation_id, created_at DESC);

-- ── collab_agent_roles ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_agent_roles (
  agent_role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  role_name TEXT NOT NULL,
  agent_type TEXT NOT NULL DEFAULT 'llm',
  capabilities JSONB DEFAULT '[]'::jsonb,
  constraints JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  policy_snapshot_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name)
);

-- ── collab_task_assignments ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_task_assignments (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  task_id UUID NOT NULL,
  assigned_role TEXT NOT NULL,
  assigned_by TEXT,
  priority INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  input_digest JSONB,
  output_digest JSONB,
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_task_assignments_run ON collab_task_assignments(tenant_id, collab_run_id, status);

-- ── collab_permission_contexts ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_permission_contexts (
  context_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  role_name TEXT NOT NULL,
  effective_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_rules JSONB,
  row_filters JSONB,
  policy_snapshot_ref TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name)
);

-- ── collab_turns (P2) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_turns (
  turn_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  turn_number INT NOT NULL,
  actor_role TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT,
  input_digest JSONB,
  output_digest JSONB,
  step_ids JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_turns_run ON collab_turns(tenant_id, collab_run_id, turn_number);

-- ── collab_coordination_events ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_coordination_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  turn_number INT NOT NULL,
  event_type TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  transition JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_coord_events_run ON collab_coordination_events(tenant_id, collab_run_id, created_at);

-- ── collab_replan_history ────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_replan_history (
  replan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  trigger TEXT NOT NULL,
  strategy TEXT NOT NULL,
  previous_step_count INT NOT NULL DEFAULT 0,
  new_step_count INT NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT false,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_replan_run ON collab_replan_history(tenant_id, collab_run_id, created_at);

-- ── collab_agent_capabilities ────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_agent_capabilities (
  capability_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  role_name TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_schema JSONB,
  output_schema JSONB,
  available BOOLEAN NOT NULL DEFAULT true,
  load_factor DECIMAL(5,2) DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name, name)
);

CREATE INDEX IF NOT EXISTS idx_collab_caps_run ON collab_agent_capabilities(tenant_id, collab_run_id);

-- ── collab_agent_messages ────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_agent_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  from_role TEXT NOT NULL,
  to_role TEXT,
  message_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reply_to UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_collab_messages_pending ON collab_agent_messages(tenant_id, collab_run_id, to_role, status, created_at)
  WHERE status IN ('pending', 'delivered');
CREATE INDEX IF NOT EXISTS idx_collab_messages_reply ON collab_agent_messages(tenant_id, reply_to);

-- ── collab_consensus_proposals ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_consensus_proposals (
  proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  proposer TEXT NOT NULL,
  proposal_type TEXT NOT NULL,
  proposal JSONB NOT NULL,
  required_voters JSONB NOT NULL DEFAULT '[]'::jsonb,
  votes JSONB NOT NULL DEFAULT '{}'::jsonb,
  deadline TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_consensus_run ON collab_consensus_proposals(tenant_id, collab_run_id, status);

-- ── collab_global_state ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_global_state (
  state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  phase TEXT NOT NULL DEFAULT 'initializing',
  current_turn INT NOT NULL DEFAULT 0,
  active_role TEXT,
  role_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_step_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  failed_step_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_step_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  replan_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id)
);

-- ── collab_state_updates ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_state_updates (
  update_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  source_role TEXT NOT NULL,
  update_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_state_updates_run ON collab_state_updates(tenant_id, collab_run_id, created_at);

-- ── collab_state_snapshots ───────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_state_snapshots (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  version INT NOT NULL,
  state_data JSONB NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_snapshots_run ON collab_state_snapshots(tenant_id, collab_run_id, version DESC);

-- ── collab_shared_state (P1-4) ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_shared_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}',
  updated_by_agent TEXT NOT NULL,
  updated_by_role TEXT,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_shared_state_key ON collab_shared_state (tenant_id, collab_run_id, key);
CREATE INDEX IF NOT EXISTS idx_collab_shared_state_run ON collab_shared_state (collab_run_id);

-- ── collab_role_permissions ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  allowed_tools TEXT[] DEFAULT NULL,
  allowed_resources TEXT[] DEFAULT NULL,
  max_budget INT DEFAULT NULL,
  used_budget INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_role_perm_agent ON collab_role_permissions (tenant_id, collab_run_id, agent_id);

-- ── collab_arbitration_log ───────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_arbitration_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  resource_key TEXT NOT NULL,
  competing_agents TEXT[] NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('priority', 'vote', 'escalate', 'first_writer_wins')),
  winner_agent TEXT,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_arbitration_run ON collab_arbitration_log (collab_run_id);

-- ── collab_cross_validation_log ──────────────────────────────
CREATE TABLE IF NOT EXISTS collab_cross_validation_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  validated_agent TEXT NOT NULL,
  validated_run_id UUID NOT NULL,
  validator_agent TEXT NOT NULL,
  validator_run_id UUID,
  verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'needs_revision')),
  confidence REAL,
  reasoning TEXT,
  revision_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_cross_validation_run ON collab_cross_validation_log (collab_run_id);

-- ── collab_role_performance ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_role_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  collab_run_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  task_completion REAL NOT NULL DEFAULT 0.5,
  quality_score REAL NOT NULL DEFAULT 0.5,
  efficiency_score REAL NOT NULL DEFAULT 0.5,
  collaboration_score REAL NOT NULL DEFAULT 0.5,
  overall_score REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_role_perf_tenant ON collab_role_performance (tenant_id, space_id, role, overall_score DESC);

-- ── Seed permissions for collab ──────────────────────────────
INSERT INTO permissions (resource_type, action)
VALUES
  ('agent_runtime', 'collab.create'),
  ('agent_runtime', 'collab.read'),
  ('agent_runtime', 'collab.events'),
  ('agent_runtime', 'collab.envelopes.write'),
  ('agent_runtime', 'collab.envelopes.read'),
  ('agent_runtime', 'collab.arbiter.commit')
ON CONFLICT (resource_type, action) DO NOTHING;

-- (原022) Collab Debate Protocol Persistence (merged from 025 + 027)
-- migration-aliases: 025_collab_debate.sql,027_debate_v2.sql
-- 多智能体辩论机制的完整持久化支持（含 v2: N方辩论 + 动态纠错 + 共识演化）
-- 关联: collabProtocol.ts Layer 5 (DebateSession/DebatePosition/DebateVerdict)

-- ── collab_debate_sessions ─────────────────────────────────
-- 辩论会话主表：记录一次完整辩论的生命周期
CREATE TABLE IF NOT EXISTS collab_debate_sessions (
  debate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  collab_run_id UUID NOT NULL REFERENCES collab_runs(collab_run_id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  side_a_role TEXT NOT NULL,
  side_b_role TEXT NOT NULL,
  arbiter_role TEXT NOT NULL DEFAULT 'orchestrator_arbiter',
  max_rounds INT NOT NULL DEFAULT 3,
  actual_rounds INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'converged', 'max_rounds_reached', 'verdicted', 'aborted')),
  -- 触发原因：为什么发起辩论
  trigger_reason TEXT NULL,
  -- 辩论结论摘要（冗余存储，便于快速查询）
  verdict_outcome TEXT NULL
    CHECK (verdict_outcome IS NULL OR verdict_outcome IN ('side_a_wins', 'side_b_wins', 'synthesis', 'inconclusive', 'multi_synthesis', 'partial_consensus')),
  verdict_winner_role TEXT NULL,
  synthesized_conclusion TEXT NULL,
  -- v2: N方辩论扩展
  parties JSONB DEFAULT '[]',
  corrections JSONB DEFAULT '[]',
  consensus_evolution JSONB DEFAULT '[]',
  debate_version SMALLINT DEFAULT 1,
  consensus_score REAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN collab_debate_sessions.parties IS 'v2: N方辩论参与方列表 [{partyId,role,stance,status,currentConfidence}]';
COMMENT ON COLUMN collab_debate_sessions.corrections IS 'v2: 动态纠错记录 [{correctionId,triggeredAtRound,correctionType,...}]';
COMMENT ON COLUMN collab_debate_sessions.consensus_evolution IS 'v2: 共识演化历史 [{step,atRound,consensusState,agreedPoints,...}]';
COMMENT ON COLUMN collab_debate_sessions.debate_version IS '辩论协议版本: 1=双方, 2=N方';
COMMENT ON COLUMN collab_debate_sessions.consensus_score IS 'v2: 最终共识度评分 (0~1)';

CREATE INDEX IF NOT EXISTS idx_debate_sessions_collab_run
  ON collab_debate_sessions (tenant_id, collab_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debate_sessions_task
  ON collab_debate_sessions (tenant_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debate_sessions_status
  ON collab_debate_sessions (tenant_id, status) WHERE status IN ('in_progress', 'verdicted');

-- ── collab_debate_positions ────────────────────────────────
-- 辩论立场表：每个Agent每轮的论点陈述
CREATE TABLE IF NOT EXISTS collab_debate_positions (
  position_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  debate_id UUID NOT NULL REFERENCES collab_debate_sessions(debate_id) ON DELETE CASCADE,
  round INT NOT NULL,
  from_role TEXT NOT NULL,
  claim TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  rebuttal_to TEXT NULL,
  confidence REAL NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  -- v2: N方辩论扩展
  party_id TEXT,
  rebuttal_targets JSONB DEFAULT '[]',
  correction_refs JSONB DEFAULT '[]',
  -- 关联的Agent运行记录
  agent_run_id UUID NULL REFERENCES runs(run_id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN collab_debate_positions.party_id IS 'v2: 所属参与方ID（N方辩论）';
COMMENT ON COLUMN collab_debate_positions.rebuttal_targets IS 'v2: 反驳目标角色列表';
COMMENT ON COLUMN collab_debate_positions.correction_refs IS 'v2: 关联的纠错记录ID列表';

CREATE INDEX IF NOT EXISTS idx_debate_positions_session
  ON collab_debate_positions (debate_id, round, from_role);
CREATE INDEX IF NOT EXISTS idx_debate_positions_tenant
  ON collab_debate_positions (tenant_id, debate_id);

-- ── collab_debate_verdicts ─────────────────────────────────
-- 辩论裁决表：仲裁方的最终裁决
CREATE TABLE IF NOT EXISTS collab_debate_verdicts (
  verdict_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  debate_id UUID NOT NULL REFERENCES collab_debate_sessions(debate_id) ON DELETE CASCADE,
  arbiter_role TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('side_a_wins', 'side_b_wins', 'synthesis', 'inconclusive', 'multi_synthesis', 'partial_consensus')),
  winner_role TEXT NULL,
  reasoning TEXT NOT NULL,
  synthesized_conclusion TEXT NOT NULL,
  -- 各轮评分 [{round, sideAScore, sideBScore}]
  round_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- v2: N方裁决扩展
  winner_roles JSONB DEFAULT '[]',
  party_scores JSONB DEFAULT '{}',
  correction_summary TEXT DEFAULT '',
  consensus_score REAL DEFAULT 0,
  -- 关联的仲裁Agent运行记录
  arbiter_run_id UUID NULL REFERENCES runs(run_id),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN collab_debate_verdicts.winner_roles IS 'v2: 多方胜出角色列表';
COMMENT ON COLUMN collab_debate_verdicts.party_scores IS 'v2: 各方最终评分 {role: score}';
COMMENT ON COLUMN collab_debate_verdicts.correction_summary IS 'v2: 纠错摘要';
COMMENT ON COLUMN collab_debate_verdicts.consensus_score IS 'v2: 最终共识度评分';

CREATE UNIQUE INDEX IF NOT EXISTS idx_debate_verdicts_session
  ON collab_debate_verdicts (debate_id);
CREATE INDEX IF NOT EXISTS idx_debate_verdicts_tenant
  ON collab_debate_verdicts (tenant_id, debate_id);

-- ── collab_debate_rounds ───────────────────────────────────
-- 辩论轮次摘要表：每轮的收敛/分歧状态
CREATE TABLE IF NOT EXISTS collab_debate_rounds (
  round_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  debate_id UUID NOT NULL REFERENCES collab_debate_sessions(debate_id) ON DELETE CASCADE,
  round INT NOT NULL,
  divergence_detected BOOLEAN NOT NULL DEFAULT true,
  -- 本轮正方置信度
  side_a_confidence REAL NULL,
  -- 本轮反方置信度
  side_b_confidence REAL NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_debate_rounds_session_round
  ON collab_debate_rounds (debate_id, round);
CREATE INDEX IF NOT EXISTS idx_debate_rounds_tenant
  ON collab_debate_rounds (tenant_id, debate_id);

-- ── Seed permissions for debate ────────────────────────────
INSERT INTO permissions (resource_type, action)
VALUES
  ('agent_runtime', 'collab.debate.create'),
  ('agent_runtime', 'collab.debate.read'),
  ('agent_runtime', 'collab.debate.verdict')
ON CONFLICT (resource_type, action) DO NOTHING;

-- ═══ v2: 辩论纠错记录表 ═══

CREATE TABLE IF NOT EXISTS debate_corrections (
  correction_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debate_id       UUID NOT NULL,
  tenant_id       TEXT NOT NULL,
  triggered_at_round INTEGER NOT NULL DEFAULT 0,
  correction_type TEXT NOT NULL CHECK (correction_type IN (
    'factual_error', 'logical_fallacy', 'evidence_conflict', 'hallucination', 'bias_detected'
  )),
  target_role     TEXT NOT NULL,
  corrected_by    TEXT NOT NULL,
  original_claim  TEXT NOT NULL,
  correction_reason TEXT NOT NULL,
  suggested_correction TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
  evidence        JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debate_corrections_debate
  ON debate_corrections (debate_id, tenant_id, triggered_at_round);

COMMENT ON TABLE debate_corrections IS 'v2: 辩论过程中的动态纠错记录';

-- ═══ v2: 共识演化历史表 ═══

CREATE TABLE IF NOT EXISTS debate_consensus_evolution (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  debate_id       UUID NOT NULL,
  tenant_id       TEXT NOT NULL,
  step            INTEGER NOT NULL,
  at_round        INTEGER NOT NULL,
  consensus_state TEXT NOT NULL CHECK (consensus_state IN (
    'no_consensus', 'partial_consensus', 'majority_consensus', 'full_consensus'
  )),
  party_positions JSONB DEFAULT '{}',
  agreed_points   JSONB DEFAULT '[]',
  divergent_points JSONB DEFAULT '[]',
  consensus_score REAL DEFAULT 0,
  evolution_note  TEXT DEFAULT '',
  recorded_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debate_consensus_evo_debate
  ON debate_consensus_evolution (debate_id, tenant_id, step);

COMMENT ON TABLE debate_consensus_evolution IS 'v2: 辩论过程中的共识演化追踪';

-- ============ merged from 032_collab_knowledge_enhance.sql (collab部分) ============
-- 协作层：envelopes 消息去重约束 + runs 恢复字段补齐

-- ── collab_envelopes: 去重约束 ─────────────────────────────

-- 先补齐 message_id 列（业务侧消息标识，区别于服务端 envelope_id）
ALTER TABLE collab_envelopes
  ADD COLUMN IF NOT EXISTS message_id TEXT;

-- 先清理已有重复行，仅保留每组最早一条（仅当 message_id 非空时去重）
WITH dups AS (
  SELECT envelope_id,
         ROW_NUMBER() OVER (
           PARTITION BY collab_run_id, message_id
           ORDER BY created_at ASC, envelope_id ASC
         ) AS rn
  FROM collab_envelopes
  WHERE message_id IS NOT NULL
)
DELETE FROM collab_envelopes
WHERE envelope_id IN (SELECT envelope_id FROM dups WHERE rn > 1);

-- 添加联合唯一约束（消息去重 DB 兜底，message_id 为 NULL 时不约束）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_collab_envelopes_run_msg'
  ) THEN
    ALTER TABLE collab_envelopes
      ADD CONSTRAINT uq_collab_envelopes_run_msg
      UNIQUE (collab_run_id, message_id);
  END IF;
END $$;

-- ── collab_runs: 恢复字段 ──────────────────────────────────

ALTER TABLE collab_runs
  ADD COLUMN IF NOT EXISTS checkpoint_state JSONB,
  ADD COLUMN IF NOT EXISTS heartbeat_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_count    INT NOT NULL DEFAULT 0;

-- ═══ Session Task Queue (merged from 023) ═══

-- 025: Session Task Queue & Task Dependencies & Checkpoints
-- Consolidated from: 026, 027(checkpoint_data), 030(task_queue_partition)
-- Multi-task concurrent execution queue with dependency management
--
-- OS 级进程管理模型：
-- - session_task_queue: 会话级任务队列（类比 OS 的进程就绪队列）
-- - task_dependencies: 任务间依赖关系（类比进程间依赖 / IPC）
-- - task_checkpoints: 检查点持久化（类比进程检查点/快照）
-- - 支持 FIFO / 优先级 / 依赖感知 / SJF 等调度策略
-- - 无硬编码并发上限，由运行时动态决定
--
-- 分区策略：PARTITION BY HASH(tenant_id)，16 个分区
-- 设计决策：
--   - 选择 tenant_id 而非 session_id 做分区键：
--     ① 基数适中（几十到几百），HASH(16) 分布均匀
--     ② 所有核心查询均以 tenant_id 开头，分区裁剪效率最高
--     ③ 避免 session_id 高基数导致的分区管理复杂度
--   - PRIMARY KEY 变为 (entry_id, tenant_id)：
--     PostgreSQL 分区表要求分区键包含在 PK 中
--     entry_id 为 UUID（全局唯一），不影响唯一性语义
--   - FK 处理：task_dependencies 和 task_checkpoints 不使用外键引用
--     分区表的 PK 为复合键，PostgreSQL 不支持跨分区的单列 FK 引用
--     entry_id 为 UUID（全局唯一），数据一致性由应用层保证

-- ── session_task_queue（HASH 分区主表）────────────────────
-- 会话级任务队列：每个会话维护独立的任务执行队列
CREATE TABLE IF NOT EXISTS session_task_queue (
  entry_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  space_id     TEXT NULL,
  session_id   TEXT NOT NULL,                          -- conversationId / sessionId
  task_id      UUID NULL,                              -- 关联的 task（answer 模式为 NULL）
  run_id       UUID NULL,                              -- 关联的 run（answer 模式为 NULL）
  job_id       UUID NULL,                              -- 关联的 job（execute 模式）

  -- 队列元数据
  goal         TEXT NOT NULL,                          -- 用户原始请求/目标
  mode         TEXT NOT NULL DEFAULT 'answer',         -- answer / execute / collab
  priority     INT NOT NULL DEFAULT 50,                -- 0=最高 100=最低，动态可调
  position     INT NOT NULL DEFAULT 0,                 -- 队列内排序位置（支持手动 reorder）

  -- 状态机
  status       TEXT NOT NULL DEFAULT 'queued',
  -- queued: 已入队等待调度
  -- ready: 依赖已就绪，可执行
  -- executing: 正在执行
  -- paused: 被用户/系统暂停
  -- completed: 执行完成
  -- failed: 执行失败
  -- cancelled: 已取消
  -- preempted: 被高优先级任务抢占（暂停）

  -- 前台/后台标记
  foreground   BOOLEAN NOT NULL DEFAULT true,          -- 前台任务获得更高事件推送优先级

  -- 调度信息
  enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at         TIMESTAMPTZ NULL,                   -- 依赖就绪时间
  started_at       TIMESTAMPTZ NULL,                   -- 开始执行时间
  completed_at     TIMESTAMPTZ NULL,                   -- 执行完成时间
  estimated_duration_ms  INT NULL,                     -- LLM 估算的执行时长

  -- 错误恢复
  retry_count      INT NOT NULL DEFAULT 0,
  last_error       TEXT NULL,
  checkpoint_ref   TEXT NULL,                          -- checkpoint 引用（用于恢复）

  -- 元数据
  created_by_subject_id TEXT NOT NULL,
  metadata         JSONB NULL,                         -- 扩展元数据（工具建议、约束等）

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 分区表要求：分区键必须包含在 PK 中
  PRIMARY KEY (entry_id, tenant_id)
) PARTITION BY HASH (tenant_id);

-- ── 创建 16 个 HASH 分区（幂等：检查首分区是否存在）─────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'session_task_queue_p0') THEN
    CREATE TABLE session_task_queue_p0  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 0);
    CREATE TABLE session_task_queue_p1  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 1);
    CREATE TABLE session_task_queue_p2  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 2);
    CREATE TABLE session_task_queue_p3  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 3);
    CREATE TABLE session_task_queue_p4  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 4);
    CREATE TABLE session_task_queue_p5  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 5);
    CREATE TABLE session_task_queue_p6  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 6);
    CREATE TABLE session_task_queue_p7  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 7);
    CREATE TABLE session_task_queue_p8  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 8);
    CREATE TABLE session_task_queue_p9  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 9);
    CREATE TABLE session_task_queue_p10 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 10);
    CREATE TABLE session_task_queue_p11 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 11);
    CREATE TABLE session_task_queue_p12 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 12);
    CREATE TABLE session_task_queue_p13 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 13);
    CREATE TABLE session_task_queue_p14 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 14);
    CREATE TABLE session_task_queue_p15 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 15);
  END IF;
END $$;

-- ── 索引（自动在每个分区上创建）──────────────────────────

-- 按会话+状态查询（最常用：获取某会话的活跃队列）
CREATE INDEX IF NOT EXISTS stq_session_status_pos_idx
  ON session_task_queue (tenant_id, session_id, status, position);

-- 按会话+入队时间查询（FIFO 调度）
CREATE INDEX IF NOT EXISTS stq_session_enqueued_idx
  ON session_task_queue (tenant_id, session_id, enqueued_at);

-- 按优先级查询（优先级调度）
CREATE INDEX IF NOT EXISTS stq_session_priority_idx
  ON session_task_queue (tenant_id, session_id, priority, enqueued_at)
  WHERE status IN ('queued', 'ready');

-- 按 task_id 反查队列条目
CREATE INDEX IF NOT EXISTS stq_task_id_idx
  ON session_task_queue (task_id)
  WHERE task_id IS NOT NULL;

-- 按 run_id 反查
CREATE INDEX IF NOT EXISTS stq_run_id_idx
  ON session_task_queue (run_id)
  WHERE run_id IS NOT NULL;

-- 按租户+状态统计（调度器全局视图）
CREATE INDEX IF NOT EXISTS stq_tenant_status_idx
  ON session_task_queue (tenant_id, status);

-- entry_id 唯一索引：用于不携带 tenant_id 的单条查询
-- 注意：分区表上的 UNIQUE INDEX 必须包含分区键
CREATE UNIQUE INDEX IF NOT EXISTS stq_entry_id_tenant_idx
  ON session_task_queue (entry_id, tenant_id);

-- ── task_dependencies ────────────────────────────────────────
-- 任务间依赖关系：DAG 结构，支持三种依赖类型
-- 注意：不使用 FK 引用 session_task_queue（分区表限制），应用层保证一致性
CREATE TABLE IF NOT EXISTS task_dependencies (
  dep_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  session_id   TEXT NOT NULL,

  -- 依赖方向：from_entry_id 依赖于 to_entry_id
  -- 即 to_entry_id 必须先完成/产出，from_entry_id 才能执行
  from_entry_id UUID NOT NULL,
  to_entry_id   UUID NOT NULL,

  -- 依赖类型
  dep_type     TEXT NOT NULL DEFAULT 'finish_to_start',
  -- finish_to_start: to 完成后 from 才能开始
  -- output_to_input: to 的输出注入 from 的输入上下文
  -- cancel_cascade: to 被取消时 from 也级联取消

  -- 依赖状态
  status       TEXT NOT NULL DEFAULT 'pending',
  -- pending: 等待满足
  -- resolved: 已满足
  -- blocked: 上游失败/取消导致永久阻塞
  -- overridden: 被用户手动覆盖/移除

  -- output 映射（output_to_input 类型使用）
  output_mapping JSONB NULL,
  -- 结构: { "sourceField": "targetField", ... }
  -- 表示将上游任务输出的哪些字段映射到下游任务的输入

  -- 依赖来源
  source       TEXT NOT NULL DEFAULT 'auto',
  -- auto: LLM 自动推断
  -- manual: 用户手动创建
  -- system: 系统规则生成

  resolved_at  TIMESTAMPTZ NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 防止重复依赖
  CONSTRAINT task_dep_unique UNIQUE (from_entry_id, to_entry_id),
  -- 防止自依赖
  CONSTRAINT task_dep_no_self CHECK (from_entry_id <> to_entry_id)
);

-- 按 from_entry_id 查找依赖（“我依赖谁”）
CREATE INDEX IF NOT EXISTS td_from_entry_idx
  ON task_dependencies (from_entry_id, status);

-- 按 to_entry_id 查找被依赖（“谁依赖我”）
CREATE INDEX IF NOT EXISTS td_to_entry_idx
  ON task_dependencies (to_entry_id, status);

-- 按会话查看全部依赖关系（DAG 可视化）
CREATE INDEX IF NOT EXISTS td_session_idx
  ON task_dependencies (tenant_id, session_id);

-- ── task_checkpoints ───────────────────────────────────────
-- 检查点持久化存储：用于宕机后从检查点恢复 executing 状态的任务
-- 注意：不使用 FK 引用 session_task_queue（分区表限制），应用层保证一致性
CREATE TABLE IF NOT EXISTS task_checkpoints (
  entry_id         UUID PRIMARY KEY,
  checkpoint_data  JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_updated
  ON task_checkpoints(updated_at);

-- ── 触发器：自动更新 updated_at ─────────────────────
CREATE OR REPLACE FUNCTION update_stq_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_stq_updated_at
  BEFORE UPDATE ON session_task_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_stq_updated_at();

CREATE OR REPLACE TRIGGER trg_td_updated_at
  BEFORE UPDATE ON task_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION update_stq_updated_at();

CREATE OR REPLACE TRIGGER trg_task_checkpoints_updated_at
  BEFORE UPDATE ON task_checkpoints
  FOR EACH ROW
  EXECUTE FUNCTION update_stq_updated_at();

-- ── 注释 ─────────────────────────────────────────────────
COMMENT ON TABLE session_task_queue IS '会话级任务队列（HASH 分区 × 16，按 tenant_id）— 每个会话维护独立的多任务执行队列，支持并发执行、优先级调度、前后台切换';
COMMENT ON COLUMN session_task_queue.priority IS '优先级权重 0-100，0 为最高优先级，支持 LLM 动态推断和运行时调整，无硬编码上限';
COMMENT ON COLUMN session_task_queue.foreground IS '前台任务获得更高的 SSE 事件推送频率和 UI 焦点';
COMMENT ON COLUMN session_task_queue.status IS '队列状态机：queued → ready → executing → completed/failed/cancelled，支持 paused/preempted 中间态';

COMMENT ON TABLE task_dependencies IS '任务间依赖关系 DAG — 支持 finish_to_start、output_to_input、cancel_cascade 三种依赖类型';
COMMENT ON COLUMN task_dependencies.dep_type IS '依赖类型：finish_to_start(完成后执行)/output_to_input(输出注入输入)/cancel_cascade(级联取消)';
COMMENT ON COLUMN task_dependencies.output_mapping IS '输出映射 JSON — 定义上游输出字段到下游输入字段的映射关系';
COMMENT ON COLUMN task_dependencies.source IS '依赖来源：auto(LLM推断)/manual(用户手动)/system(系统规则)';

COMMENT ON TABLE task_checkpoints IS '任务检查点持久化存储 — 记录任务执行的中间状态，用于宕机恢复';
COMMENT ON COLUMN task_checkpoints.checkpoint_data IS '检查点数据 JSON — 包含当前步骤、中间结果、执行上下文等';

-- (原026) Scheduler Metrics Snapshots
-- P2-G7: 调度器指标定期快照持久化

CREATE TABLE IF NOT EXISTS scheduler_metrics_snapshots (
  snapshot_id    TEXT PRIMARY KEY DEFAULT 'singleton',
  metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 历史快照（可选，按需启用 retention）
CREATE TABLE IF NOT EXISTS scheduler_metrics_history (
  id             BIGSERIAL PRIMARY KEY,
  metrics        JSONB NOT NULL,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduler_metrics_history_at
  ON scheduler_metrics_history (snapshot_at DESC);

-- 保留最近 7 天快照（由应用层或 cron 清理）
COMMENT ON TABLE scheduler_metrics_snapshots IS '调度器指标最新快照（单行 UPSERT）';
COMMENT ON TABLE scheduler_metrics_history IS '调度器指标历史快照（定期追加，用于趋势分析）';

-- (原034) Task Queue Index Optimization
-- 补充 session_task_queue 的复合索引，覆盖高频并发调度查询模式，消除全表扫描风险

-- ── 1. 活跃条目部分索引（排除终态，position DESC 优化 MAX 聚合）────
-- 覆盖查询：insertQueueEntry(MAX(position))、listActiveEntries、
--           listResumableEntries、cancelAllActive、reorderEntry
-- position DESC 使 MAX(position) 直接取首行即返回，避免反向遍历
CREATE INDEX IF NOT EXISTS stq_active_position_idx
  ON session_task_queue (tenant_id, session_id, position DESC)
  WHERE status NOT IN ('completed', 'failed', 'cancelled');

-- ── 2. 执行中任务计数覆盖索引 ──────────────────────
-- 覆盖查询：countExecuting（COUNT(*) WHERE status='executing'）
-- INCLUDE(entry_id) 实现完全 Index-Only Scan，同时支持按 entry_id 快速定位
CREATE INDEX IF NOT EXISTS stq_executing_idx
  ON session_task_queue (tenant_id, session_id)
  INCLUDE (entry_id)
  WHERE status = 'executing';

-- ── 3. 僵尸任务检测索引 ──────────────────────────
-- 覆盖查询：listZombieExecutingEntries、listStaleExecutingEntries
-- 这两个查询不带 tenant_id（全分区扫描），需独立索引
CREATE INDEX IF NOT EXISTS stq_executing_started_idx
  ON session_task_queue (started_at ASC)
  WHERE status = 'executing';

-- ── 4. 关闭恢复索引 ────────────────────────────
-- 覆盖查询：listShutdownPausedEntries（status='paused' AND checkpoint_ref LIKE 'shutdown:%'）
CREATE INDEX IF NOT EXISTS stq_paused_checkpoint_idx
  ON session_task_queue (status)
  WHERE status = 'paused' AND checkpoint_ref IS NOT NULL;

-- ── 5. 租户待处理任务聚合索引 ────────────────────
-- 覆盖查询：listSessionsWithPendingTasks（GROUP BY session_id）
CREATE INDEX IF NOT EXISTS stq_tenant_active_session_idx
  ON session_task_queue (tenant_id, session_id)
  WHERE status NOT IN ('completed', 'failed', 'cancelled');

-- ── 6. 历史分页查询索引 ────────────────────────
-- 覆盖查询：listHistoryEntries（ORDER BY enqueued_at DESC LIMIT/OFFSET）
-- 现有 stq_session_enqueued_idx 为 ASC，补充 DESC 索引避免反向扫描
CREATE INDEX IF NOT EXISTS stq_session_enqueued_desc_idx
  ON session_task_queue (tenant_id, session_id, enqueued_at DESC);

-- ── 7. 可调度任务选取复合索引（覆盖 listSchedulable 热路径）─────
-- 查询模式：SELECT ... WHERE tenant_id=$1 AND session_id=$2
--           AND status IN ('queued','ready') ORDER BY priority ASC, enqueued_at ASC
-- 部分索引仅含 queued/ready 行，体积极小；排序列内嵌索引避免 filesort
CREATE INDEX IF NOT EXISTS stq_schedulable_dispatch_idx
  ON session_task_queue (tenant_id, session_id, priority ASC, enqueued_at ASC)
  WHERE status IN ('queued', 'ready');

-- ═══ Replan Episodes (merged from 025) ═══

-- 重规划经验表：记录 diagnose → strategy → outcome 闭环
CREATE TABLE IF NOT EXISTS replan_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  trace_id TEXT NOT NULL,
  collab_run_id TEXT,
  diagnosis JSONB NOT NULL,
  strategy TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  feasibility_score REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replan_episodes_tenant_trace ON replan_episodes (tenant_id, trace_id);
CREATE INDEX IF NOT EXISTS idx_replan_episodes_type ON replan_episodes (tenant_id, (diagnosis->>'failureType'), created_at DESC);
