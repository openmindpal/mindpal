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
