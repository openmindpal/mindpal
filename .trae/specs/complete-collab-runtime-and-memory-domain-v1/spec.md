# 多智能体协作与记忆域补全 Spec

## Why
多智能体协作与记忆域已具备基础能力，但缺少“可回放关联字段”“step 级写入互斥”“会话上下文读写/导出清除”等最小闭环，导致审计与回放链路不稳定、并发写入语义不一致。

## What Changes
- 多智能体协作：
  - 将单主写入从“角色约束”扩展为 **step 级租约**（resourceRef），用于保护协作协议中的关键提交与状态写入。
  - 对 collab envelopes / events 记录强制补齐 `policySnapshotRef` 与 `correlationId`，并在存储层可查询、可回放串联。
  - 补齐 Guard/Retriever 最小角色闭环：默认/校验确保协作运行具备必要角色，避免协议消息无人处理或无法追溯。
  - **BREAKING**：协议写入接口在缺失 `correlationId` 时拒绝写入；SINGLE_WRITER_VIOLATION 语义对外稳定化。
- 记忆域：
  - 增加 `session_context` 读写 API（面向 `memory_session_contexts`），支持按 sessionId 获取/覆盖更新/清除。
  - 扩展 `writePolicy` 输入：从仅 `confirmed` 扩展为 `confirmed/approved/policyAllowed`。
  - 新增“导出+清除”审计化接口，支持用户自助导出（默认脱敏）并进行清除（软删除）且可审计。

## Impact
- Affected specs:
  - 多智能体协作（协作协议、回放链路、单主写入）
  - 审计与合规（policySnapshotRef、correlationId、导出/清除）
  - 记忆层（偏好长期记忆、会话上下文、任务状态恢复）
- Affected code:
  - API：`collabRuntime.ts`、`memory.ts`
  - DB migrations：`079_collab_runs.sql`、`100_collab_envelopes.sql`、`012_memory.sql`
  - Repo：`modules/agentRuntime/*Repo.ts`、`modules/memory/repo.ts`、`modules/memory/sessionContextRepo.ts`
  - Tests：e2e collab runtime、e2e memory

## ADDED Requirements
### Requirement: Collab step 级租约（resourceRef）
系统 SHALL 对协作协议中的关键“写入/提交”操作启用 step 级租约互斥，租约键由 `{tenantId, spaceId, resourceRef}` 唯一标识。

#### 定义（MVP）
- resourceRef：`collab_step:${collabRunId}:${correlationId}`（同一协作运行内同一相关性提交互斥）
- owner：{ runId, stepId, traceId, actorRole }
- ttl：复用现有 workflow write lease 表的 TTL 语义（短租约，可自动回收）

#### Scenario: 非单主提交触发 SINGLE_WRITER_VIOLATION
- **GIVEN** 同一 `resourceRef` 的租约已被其他 owner 持有且未过期
- **WHEN** 另一个提交者尝试对同一 `resourceRef` 执行协议写入/提交
- **THEN** 系统 SHALL 拒绝并返回 `errorCode = "SINGLE_WRITER_VIOLATION"`
- **AND** 事件流中记录 `collab.single_writer.violation` 且包含 `correlationId` 与 `policySnapshotRef`

### Requirement: Collab envelopes/events 强制回放字段
系统 SHALL 在 collab envelopes 与 collab run events 中强制持久化以下字段，并保证可用于回放串联：
- `policySnapshotRef`：写入时的授权快照引用（字符串，格式 `policy_snapshot:<uuid>`）
- `correlationId`：相关性标识（非空字符串）

#### Scenario: 写入 envelope 时字段完整
- **WHEN** 调用 envelopes 写入接口
- **THEN** 系统 SHALL 要求请求包含 `correlationId`
- **AND** 系统 SHALL 将本次写入授权的 `policySnapshotRef` 记录到 envelope 与对应的 `collab.envelope.sent` event

#### Scenario: 写入事件时字段完整
- **WHEN** 系统生成 collab run event（包含 worker 侧 step.started/completed/failed 等）
- **THEN** 系统 SHALL 尽可能关联到对应 step 的 `policySnapshotRef`
- **AND** 系统 SHALL 记录 `correlationId`（若来自协作协议动作/提交；或能从 step 输入/关联记录推导）

### Requirement: Guard/Retriever 最小角色闭环
系统 SHALL 确保协作运行具备可工作的最小角色集合，以保证协议消息流能被处理并可回放解释：
- 至少包含：`planner`、`retriever`、`guard`、`executor`、`reviewer`、`arbiter`

#### Scenario: 角色缺失时自动补齐
- **WHEN** 创建协作运行且未显式提供 roles
- **THEN** 系统 SHALL 使用包含 `guard/retriever` 的默认 roles
- **AND** **WHEN** 提供 roles 但缺失 `guard` 或 `retriever`
- **THEN** 系统 SHALL 拒绝创建或自动补齐（实现选其一，需保持行为稳定并可测试）

### Requirement: 记忆 session_context 读写
系统 SHALL 提供 session_context 的读写能力，并严格按 `{tenantId, spaceId, subjectId}` 隔离。

#### Scenario: 写入并读取 session_context
- **WHEN** 用户写入某 `sessionId` 的 context
- **THEN** 读取同 `sessionId` 返回最新 context（覆盖更新）
- **AND** 其他 spaceId 或其他 subjectId 不可读到该 context

### Requirement: 记忆 writePolicy 扩展
系统 SHALL 允许 `writePolicy ∈ {confirmed, approved, policyAllowed}`，并将该值持久化用于审计与治理分析。

### Requirement: 记忆导出+清除审计化
系统 SHALL 提供导出并清除记忆的接口，且默认导出内容脱敏、清除为软删除，并写入审计摘要（scope、数量、是否脱敏）。

## MODIFIED Requirements
### Requirement: Memory 搜索与片段脱敏
系统 SHALL 在 memory search 的 evidence snippet 中默认进行脱敏处理，且不得返回 token/key 等敏感明文。

### Requirement: Task state 覆盖更新与恢复读取
系统 SHALL 支持同一 `{tenantId, spaceId, runId}` 的 task_state 覆盖更新，并在 GET 时返回最新状态（用于中断恢复）。

## REMOVED Requirements
（无）

