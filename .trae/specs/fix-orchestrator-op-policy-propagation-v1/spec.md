# 修复 Orchestrator 执行的操作级策略传播 V1 Spec

## Why
《架构设计.md》不变式要求“策略先于执行、授权决策必须产出可解释快照（Policy Snapshot）并用于回放一致性与可解释审计”，且字段级/行级策略必须在执行时生效。

目前 `/orchestrator/execute` 仅对工具契约的 `resourceType/action` 做授权校验，但在创建 step 时：
- 未将操作级授权决策中的 `fieldRules/rowFilters` 传播到 `step.input.toolContract`，可能导致 Worker 执行阶段无法按字段/行策略收敛写入；
- 使用了 `orchestrator:execute` 的 `policySnapshotRef` 作为 step/run 的快照引用，而非“实际操作（resourceType/action）”的快照引用，影响一致性与可解释审计。

因此需要修复：在 Orchestrator 执行链路使用并传播“操作级”授权决策（含 snapshotRef/fieldRules/rowFilters），并保证审批审计与 step 绑定一致。

## What Changes
- `/orchestrator/execute`：
  - 保存“操作级”授权结果 `opDecision = requirePermission(resourceType, action)`
  - `createJobRunStep(policySnapshotRef)` 使用 `opDecision.snapshotRef`
  - `step.input.toolContract` 增加 `fieldRules/rowFilters`（来自 `opDecision`）
  - `approval.requested` 审计事件使用 `opDecision`（与 tools.execute 保持一致）

## Impact
- Affected specs:
  - AI 编排层（受控工具调用与回放）
  - 认证与授权（字段级/行级策略在执行阶段生效）
  - 审计域（policySnapshotRef 统一指向实际操作）
- Affected code:
  - API：`apps/api/src/routes/orchestrator.ts`
  - Tests：`apps/api/src/__tests__/e2e.test.ts`

## ADDED Requirements

### Requirement: OrchestratorExecuteUsesOpPolicySnapshotV1
- **WHEN** 调用 `POST /orchestrator/execute` 创建 job/run/step
- **THEN** 系统 MUST 使用“操作级授权决策”的 `snapshotRef` 作为 `policySnapshotRef`

### Requirement: OrchestratorExecutePropagatesFieldAndRowRulesV1
- **WHEN** `POST /orchestrator/execute` 创建 step
- **THEN** 系统 MUST 将操作级授权决策中的 `fieldRules/rowFilters` 写入 `step.input.toolContract`
- **AND** Worker 执行阶段应据此执行字段裁剪/写入拒绝/行级限制（沿用既有逻辑）

### Requirement: OrchestratorApprovalAuditUsesOpDecisionV1
- **WHEN** `POST /orchestrator/execute` 触发审批（needs_approval）
- **THEN** `workflow:approval.requested` 的审计事件 MUST 关联操作级授权决策（policyDecision=opDecision）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

