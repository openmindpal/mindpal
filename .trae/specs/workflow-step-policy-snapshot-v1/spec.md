# Workflow Step Policy Snapshot（Step 级权限快照引用）V1 Spec

## Why
当前权限快照（policy snapshot）主要固化在 Run 维度（`runs.policy_snapshot_ref`）。根据《架构-07-工作流与自动化-审批队列幂等.md》的建议，Step 作为最小执行单元也应绑定其执行时刻的权限快照，用于可解释审计、回放一致性与问题排查，尤其在未来多 Step/补偿/Saga 场景下，Run 级别快照不足以表达“每一步在什么授权语境下被放行”。

## What Changes
- 为 `steps` 表新增 `policy_snapshot_ref` 字段，用于记录该 step 对应的权限快照引用
- 创建 step（尤其是 `jobType=tool.execute`）时，将权限决策产生的 `snapshotRef` 同步写入 `steps.policy_snapshot_ref`
- API 的 step 列表/详情返回中包含 `policySnapshotRef`（只返回引用，不展开快照内容）
- 兼容历史数据：旧 step 不回填，字段可为 null

## Impact
- Affected specs:
  - 工作流与自动化（Run/Step 快照）
  - 认证与授权（Policy Snapshot 绑定）
  - 审计域（可解释性与追踪）
- Affected code:
  - DB 迁移：steps 表新增列
  - Workflow repo：创建 step 与 listSteps/映射结构
  - API routes：runs/steps 列表输出结构（如适用）

## ADDED Requirements

### Requirement: StepPolicySnapshotRefV1
系统 SHALL 在 step 维度存储权限快照引用 `policy_snapshot_ref`。

#### Scenario: tool.execute 创建 step 时绑定快照引用
- **WHEN** API 创建 `jobType=tool.execute` 的执行作业并生成 step
- **THEN** `steps.policy_snapshot_ref` MUST 等于该次授权决策的 `snapshotRef`
- **AND** 对外返回的 step 结构包含 `policySnapshotRef`

### Requirement: BackwardCompatibleNullV1
系统 SHALL 兼容历史 steps：
- **WHEN** step 记录创建于该功能之前
- **THEN** `steps.policy_snapshot_ref` 允许为 null，且不影响现有查询与执行链路

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

