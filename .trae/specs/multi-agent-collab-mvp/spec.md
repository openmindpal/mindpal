# 多智能体协作（Task/角色/通信与权限上下文）MVP Spec

## Why
《架构-18》要求在多代理并行与长期运行时，仍保持统一请求链路与可追溯性：每次决策/工具调用都能定位到 agentRole、taskId、runId/stepId 与 policySnapshotRef，且跨代理只共享摘要与引用，避免越权与重复副作用。当前系统已有 Run/Step、审批、回放与审计，但缺少“Task 一等对象”与 agentRole/correlation 的标准化记录与查询。

## What Changes
- 新增 Task 一等对象（MVP）：
  - 用于承载用户可见目标，并与多个 Run 关联
- 新增 Agent Message Envelope 存储（MVP）：
  - 记录多角色协作消息（plan/retrieve/execute/review/respond）的摘要与引用
- 审计对齐（MVP）：
  - 在审计事件中可追溯 `taskId` 与 `agentRole`（允许作为字段或可检索摘要）
- API（MVP）：
  - `POST /tasks` 创建 task
  - `GET /tasks` 列表
  - `GET /tasks/:taskId` 详情（含关联 runs 摘要）
  - `POST /tasks/:taskId/messages` 写入一条 agent message（仅摘要）
  - `GET /tasks/:taskId/messages` 查询消息时间线（分页/limit）

## Impact
- Affected specs:
  - 多智能体协作（角色、通信、任务分配、权限上下文）
  - 工作流与自动化（Task ↔ Run/Step 关联）
  - 审计域（可追溯性与回放）
  - 记忆层（共享引用与摘要，不共享敏感原文）
- Affected code:
  - DB：新增 tasks 与 agent_messages（或等价）
  - API：新增 tasks 路由与 repo
  - 审计：新增 taskId/agentRole 记录方式（字段或摘要）

## ADDED Requirements

### Requirement: Task 对象（MVP）
系统 SHALL 提供 Task 一等对象以承载用户目标：
- 最小字段（MVP）：
  - taskId、tenantId、spaceId、createdBySubjectId
  - title（可选）、status（open|closed）
  - createdAt/updatedAt

#### Scenario: 创建 task
- **WHEN** 用户创建 task
- **THEN** 返回 taskId
- **AND** 后续 runs 可引用该 taskId

### Requirement: Agent Message Envelope（MVP）
系统 SHALL 支持写入与查询 agent message，并强制“只共享摘要与引用”：
- 最小字段（MVP）：
  - messageId、taskId、tenantId、spaceId
  - from：{ agentId?, role }
  - correlation：{ runId?, stepId?, jobId?, requestId?, traceId? }
  - intent：plan|retrieve|execute|review|observe|respond
  - inputs：{ userGoalDigest, constraints?, policySnapshotRef?, evidenceRefs?, contextRefs? }
  - outputs：{ plan?, toolCall?, decision?, observation? }（仅 digest/ref）
  - createdAt

约束（MVP）：
- message MUST 不包含敏感原文（只允许 digest/ref）
- write/read 必须遵守 tenant/space 隔离

#### Scenario: 写入消息
- **WHEN** Coordinator/Planner/Retriever/Executor/Guard 写入一条 message
- **THEN** message 可被 `GET /tasks/:taskId/messages` 检索
- **AND** 审计记录包含 taskId 与 role（摘要）

### Requirement: 审计对齐（MVP）
系统 SHALL 让关键操作可追溯到 taskId 与 agentRole：
- `POST /tasks/*` 与 `POST /tasks/:taskId/messages` 必须写审计
- 工具执行/审批/回放等链路 SHOULD 在审计中包含 taskId/agentRole（MVP 可先在 inputDigest/outputDigest 中携带）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

