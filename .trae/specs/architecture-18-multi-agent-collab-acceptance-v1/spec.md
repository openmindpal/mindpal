# 架构-18（多智能体协作）验收清单 Spec（补强）

## Why
多智能体协作的关键风险在于并发写冲突与跨代理泄露敏感信息。架构-18需要把“单主写入仲裁”“协作消息可观测”“最小共享与脱敏”固化为可重复的验收与回归断言。

## What Changes
- 固化“写入单主（write lease / single writer）”验收断言：并发写冲突必须仲裁并返回 409，且可追溯
- 固化“协作消息 Envelope 与事件可观测”验收断言：envelopes 落表，具备 correlation（taskId/runId/stepId）与摘要字段
- 增强“最小共享与脱敏”验收：跨代理传递仅共享 ref/digest，不泄露敏感 payload；在 e2e 与审计抽样中固化断言（对齐现有 DLP/audit 能力）

## Impact
- Affected specs:
  - add-agent-write-lease-v1
  - deepen-multi-agent-collab-protocol-and-governance-v1
  - complete-collab-runtime-and-memory-domain-v1
  - safety-dlp-mvp
  - audit-retention-siem-export-v1（间接：审计摘要约束）
- Affected code:
  - apps/api/src/__tests__/e2e.test.ts（新增/加强断言）
  - apps/api/src/modules/collab/collabEnvelopeRepo.ts（读取验证点）
  - apps/api/src/routes/collabRuntime.ts / apps/api/src/routes/agentRuntime.ts（入队/事件字段验证点）
  - apps/api/src/modules/audit/*（审计摘要抽样验证点）
  - apps/api/migrations/100_collab_envelopes.sql（数据表约束回归）

## ADDED Requirements
### Requirement: 写入单主（write lease）冲突仲裁与可追溯
系统 SHALL 在发生并发写冲突时仲裁并返回 409，且可通过事件/审计追溯冲突原因。

#### Scenario: 并发写冲突返回 409
- **WHEN** 非单主尝试提交共享状态或写入需要租约的写操作
- **THEN** 返回 409（稳定错误码，如 SINGLE_WRITER_VIOLATION / COLLAB_SINGLE_WRITER_VIOLATION）
- **AND** 写入可追溯事件（如 collab.single_writer.violation）与审计摘要

### Requirement: 协作消息 Envelope 与事件可观测（correlation + 摘要）
系统 SHALL 将协作消息以 envelope 形式落库，并携带 correlation 与摘要字段，用于回放与排障。

#### Scenario: envelopes 必须落表且可按 correlation 查询
- **WHEN** 产生协作消息 envelope（proposal/decision/diagnostic 等）
- **THEN** 记录落入 collab_envelopes
- **AND** 记录包含 correlationId 且可串联 taskId/runId/stepId（至少其中之一）
- **AND** 审计仅记录摘要，不包含敏感明文 payload

### Requirement: 最小共享原则与脱敏（跨代理仅 ref/digest）
系统 SHALL 保证跨代理传递的数据仅包含引用/摘要（ref/digest），不得包含敏感 payload 明文；该约束必须通过 e2e 与审计抽样断言固化。

#### Scenario: 跨代理不泄露敏感 payload
- **WHEN** envelope 中包含与工具执行/数据写入相关的信息
- **THEN** 只允许出现 ref/digest（例如 mediaRef/evidenceDigest/outputDigest/secretRef 等）
- **AND** 不允许出现明文 token/key/secret、明文完整 payload、或可直接复原的内容

#### Scenario: 审计摘要抽样不泄露
- **WHEN** 发生冲突/拒绝/审批/评测等治理事件写审计摘要
- **THEN** 审计中仅包含摘要字段（digest/id/ref/计数/状态）
- **AND** 不包含敏感 payload 或密钥明文

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

