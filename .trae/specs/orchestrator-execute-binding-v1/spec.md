# 编排层 Execute Binding（对话建议→受控执行）V1 Spec

## Why
当前平台已具备 Orchestrator（仅建议）、Tool 执行入口（/tools/:toolRef/execute）、审批与队列执行，但缺少《架构-08》要求的“编排层到受控执行的闭环绑定”，导致对话产出的 toolSuggestion 无法以统一的编排入口被确认与执行，也不利于后续做多步编排与评测回归。

## What Changes
- 新增 Orchestrator Execute API（V1）：
  - `POST /orchestrator/execute`：接收用户确认的 `toolRef + inputDraft`，复用现有执行链路创建 job/run/step（或创建 approval）
- 强制契约与治理校验（V1）：
  - toolRef 必须存在且 released
  - tool 在当前租户/空间必须启用
  - inputDraft 需通过最小 inputSchema 校验（必填/类型子集）
  - 写操作必须携带/生成 idempotencyKey
- 审计补齐（V1）：
  - `resourceType=orchestrator, action=execute`，记录 requestId/traceId、toolRef、结果摘要（queued/needs_approval 与 runId/stepId）
- 运行绑定（V1）：
  - run.trigger 置为 `orchestrator`（与 manual 区分）
  - approval 的 binding 字段与 step/run 绑定保持一致（沿用已落地的 binding 机制）

## Impact
- Affected specs:
  - AI 编排层（受控工具调用与回放）
  - BFF/API 与统一请求链路（新增编排执行入口）
  - 工作流与自动化（审批/队列复用）
  - 审计域（新增 orchestrator:execute 事件）
- Affected code:
  - API：新增 orchestrator execute 路由与复用执行逻辑
  - 测试：API e2e 覆盖 execute 成功/需审批/参数非法

## ADDED Requirements

### Requirement: Orchestrator Execute API（V1）
系统 SHALL 提供编排层执行入口：
- `POST /orchestrator/execute`

请求体（V1）至少包含：
- toolRef: string
- input: object（即 inputDraft 的最终确认版本）
- idempotencyKey?: string（可选；写工具若未提供由系统生成并返回）

响应体（V1）至少包含（与现有 tools execute 保持一致语义）：
- jobId、runId、stepId
- approvalId?（当进入审批时）
- receipt：{ status: "queued" | "needs_approval"; correlation: { requestId, traceId, runId, stepId, approvalId? } }

#### Scenario: 低风险或无需审批的执行
- **WHEN** 用户调用 `/orchestrator/execute` 且该 tool 不需要审批
- **THEN** 系统创建 job/run/step 并入队执行，返回 receipt.status=queued
- **AND** run.trigger = "orchestrator"
- **AND** 写入审计 `orchestrator:execute`

#### Scenario: 高风险/需要审批的执行
- **WHEN** 用户调用 `/orchestrator/execute` 且该 tool 需要审批
- **THEN** 系统创建 run 并置为 needs_approval，创建 approval，返回 receipt.status=needs_approval 与 approvalId
- **AND** approval 绑定字段与 run/step 绑定一致（toolRef/policySnapshotRef/inputDigest）
- **AND** 写入审计 `orchestrator:execute`

#### Scenario: toolRef 不存在/未发布/未启用
- **WHEN** 用户调用 `/orchestrator/execute` 使用不可用的 toolRef
- **THEN** 返回 403/404（稳定 errorCode），并写拒绝审计（deny 可追溯）

#### Scenario: 入参不符合契约
- **WHEN** input 无法通过最小 inputSchema 校验
- **THEN** 返回 400（稳定 errorCode=BAD_REQUEST），并写审计摘要（不含敏感原文）

### Requirement: 不引入旁路执行（V1）
`/orchestrator/execute` SHALL 复用现有 tool 执行路径的核心校验与状态机：
- 鉴权/授权决策
- 工具启用态检查
- 审批分流与入队
- 审计与 trace 贯通

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

