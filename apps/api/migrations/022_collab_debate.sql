-- migration-aliases: 025_collab_debate.sql,027_debate_v2.sql
-- 022: Collab Debate Protocol Persistence (merged from 025 + 027)
-- 多智能体辩论机制的完整持久化支持（含 v2: N方辩论 + 动态纠错 + 共识演化）
-- 关联: collabProtocol.ts Layer 5 (DebateSession/DebatePosition/DebateVerdict)

-- ── collab_debate_sessions ─────────────────────────────────────
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

-- ── collab_debate_positions ────────────────────────────────────
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

-- ── collab_debate_verdicts ─────────────────────────────────────
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

-- ── collab_debate_rounds ───────────────────────────────────────
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

-- ── Seed permissions for debate ────────────────────────────────
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
