# Tool/Skill 契约对齐（scope + 资源动作 + 需审批）V1 Spec

## Why
《架构设计.md》与《架构-08 AI 编排层》要求 Tool/Skill 作为可插拔能力单元，对外暴露受控接口（read/write/需审批），并纳入统一链路（鉴权→校验→授权→执行→审计）。当前实现已具备 Tool Registry、治理启用（rollout）、运行时护栏（timeout/并发/出站治理）与 Workflow Run/Step，但工具契约缺少 scope/resourceType/action 等关键字段，approvalRequired 也未形成执行闭环，且编排器未对齐治理的 effective toolRef。

## What Changes
- 扩展 Tool Contract（V1）：新增 `scope(read|write)`、`resourceType`、`action`、`idempotencyRequired`
- 执行链路对齐（V1）：执行前做 scope/幂等/授权映射校验，并对 approvalRequired/riskLevel 做“阻断执行→进入审批态”的闭环
- 治理与编排对齐（V1）：编排器与执行入口统一按治理规则解析 effective toolRef（tenant active + space override + rollout enable）
- Schema 校验增强（V1）：补齐 outputSchema 校验与输出裁剪（仅结构化字段，不记录敏感原文）
- 统一回执（V1）：所有工具执行返回标准化 receipt（correlation/status/errorCode），可用于回放与运营

## Impact
- Affected specs:
  - AI 编排层（受控工具调用与回放）
  - Tool Registry 与治理启用（rollout/active/override）
  - Workflow 引擎（needs_approval 状态与审批动作）
  - 审计域（资源动作/决策摘要/回执一致性）
- Affected code:
  - DB：tool_definitions 扩展字段；可能新增 approvals（或复用 runs/steps 状态机）
  - API：/tools 发布与执行入口；新增审批 API（approve/reject）与 receipt 查询
  - Orchestrator：选工具时使用 effective toolRef 并注入 contract 字段
  - Worker：执行前检查 run/step 状态（needs_approval 不执行）

## ADDED Requirements

### Requirement: Tool Contract V1（新增字段）
系统 SHALL 为每个 toolRef 维护以下字段，并在 publish 时校验完整性：
- `scope`：read | write
- `resourceType`：如 entity/memory/knowledge/connector/secret/channel/sync/workflow
- `action`：稳定动作名（create/read/update/delete/execute/push/pull 等）
- `idempotencyRequired`：boolean（write 默认 true；read 默认 false）

#### Scenario: 发布时缺字段被拒绝
- **WHEN** 发布 tool definition 缺少 scope/resourceType/action
- **THEN** 拒绝发布并返回稳定错误码

### Requirement: 执行前的契约校验与统一授权映射
系统 SHALL 在执行工具前完成：
- inputSchema 校验（现有）
- scope→幂等要求校验：
  - scope=write 且 idempotencyRequired=true 时，必须携带 idempotency-key
- 统一授权映射：
  - requirePermission(resourceType=tool.resourceType, action=tool.action)
  - 保持与现有“工具执行权限”兼容（见 MODIFIED Requirements）

#### Scenario: write 未携带幂等键被拒绝
- **WHEN** scope=write 的工具执行请求未携带 idempotency-key
- **THEN** 返回 400 且写审计（policy_violation）

### Requirement: approvalRequired 闭环（V1）
系统 SHALL 对 `approvalRequired=true` 或 `riskLevel=high` 的工具执行走审批闭环：
- 创建 run/step（锁定 toolRef、policySnapshot、inputDigest、idempotencyKey）
- run 状态进入 `needs_approval`，且 worker MUST NOT 执行该 run 的 step
- 返回 receipt：`status=needs_approval` + `correlation={runId,stepId,traceId,requestId}`
- 提供审批接口（V1）：
  - approve：将 run 置为 queued 并入队执行
  - reject：将 run 置为 canceled/denied 并产出回执

#### Scenario: 需审批的工具不会自动执行
- **WHEN** 执行 approvalRequired 的工具
- **THEN** 不会产生任何副作用（worker 不执行）
- **AND** receipt 返回 needs_approval

### Requirement: effective toolRef 解析（V1）
系统 SHALL 在编排与执行入口统一解析 effective toolRef：
- 若请求只给 toolName（或 toolRef 可选），按以下规则解析：
  1) space override（如存在）
  2) tenant active toolRef（如存在）
  3) latest released toolRef（回退）
- 解析后还必须检查 rollout enable；未启用则拒绝并返回稳定错误码

#### Scenario: 未启用的工具拒绝执行
- **WHEN** toolRef 在该 tenant/space 未启用（rollout disabled）
- **THEN** 返回 403 且审计记录治理拒绝原因摘要

### Requirement: outputSchema 校验与裁剪（V1）
系统 SHALL 在 worker 完成工具执行后：
- 对 output 做 outputSchema 校验（不通过则标记 failed 且 errorCategory=internal）
- 对 output 进行脱敏裁剪（按 schema 输出结构，避免原文泄露）
- steps.outputDigest 与审计仅记录摘要（latencyMs、egressSummary、outputKeysDigest 等）

### Requirement: 统一回执（Receipt）V1
系统 SHALL 为工具执行提供标准化回执结构：
- correlation：{ requestId, traceId, runId?, stepId? }
- status：received|needs_approval|queued|running|succeeded|failed|canceled|denied
- errorCode（可选）
- resultSummary（可选，结构化摘要）

#### Scenario: 可回放摘要一致
- **WHEN** 同一 toolRef + policySnapshot + inputDigest 重放
- **THEN** 回执 correlation 可用于定位同一轨迹（审计可查）

## MODIFIED Requirements

### Requirement: 现有 tools.execute 权限模型（兼容扩展）
现有 `requirePermission(resourceType='tool', action='execute')` SHALL 继续作为兼容入口；V1 新增的 resourceType/action 授权映射 SHALL 在此基础上叠加执行（两者都必须通过，或通过配置选择迁移策略）。

## REMOVED Requirements
（无）

