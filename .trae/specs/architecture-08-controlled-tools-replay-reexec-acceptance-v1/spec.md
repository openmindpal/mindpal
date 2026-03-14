# 架构-08（AI 编排：受控工具调用与回放）验收清单 Spec

## Why
架构-08要求 AI 编排层的工具调用“可控、可解释、可回放”，并严格区分 Replay（只读复现）与 Re-exec（真实重执行）语义，以降低外部副作用与合规风险。

## What Changes
- 工具契约强校验验收：入参按 schema 强校验、失败可解释；高风险/需审批进入审批闭环
- Replay 与 Re-exec 语义验收：Replay 只复现轨迹与证据、不触发副作用；Re-exec 新建 run/step 并形成可追溯关联
- （可选）“replay 评测准入”产品化：补齐 eval runner，将 replay 结果与期望对比产出 eval_runs（依赖架构-16）

## Impact
- Affected specs:
  - align-tool-contract-v1
  - workflow-replay-v1
  - orchestrator-replay-approval-binding-v1
  - add-workflow-deadletter-reexec-v1
- Affected code:
  - apps/api/src/routes/tools.ts
  - apps/api/src/routes/runs.ts
  - apps/api/src/modules/workflow/replay.ts

## ADDED Requirements
### Requirement: 工具契约强校验（输入）
系统 SHALL 在工具执行入口对请求入参按工具 inputSchema 进行强校验，并在失败时返回可解释错误。

#### Scenario: 输入校验成功
- **WHEN** 调用工具执行入口，入参满足 inputSchema
- **THEN** 执行进入正常路径（queued/running/… 或 needs_approval）

#### Scenario: 输入校验失败可解释
- **WHEN** 调用工具执行入口，入参不满足 inputSchema
- **THEN** 返回稳定 errorCode
- **AND** 返回可解释的校验错误摘要（字段路径/期望类型/缺失必填等）
- **AND** 不创建任何会触发外部副作用的执行作业

### Requirement: 风险→审批闭环（工具执行）
系统 SHALL 对 `risk=high` 或 `approvalRequired=true` 的工具执行进入审批态 `needs_approval`，并创建审批记录。

#### Scenario: 进入审批态
- **WHEN** 执行 risk=high 或 approvalRequired 的工具
- **THEN** 返回 receipt.status = needs_approval
- **AND** 创建 approval 记录可查询
- **AND** worker 不得执行该 step

### Requirement: Replay 只读复现（不可触发副作用）
系统 SHALL 将 Replay 定义为“复现轨迹与证据”的只读操作，输出仅包含 timeline/digest/引用信息，且不得触发任何外部副作用。

#### Scenario: Replay 输出轨迹与证据
- **WHEN** 调用 `GET /runs/:runId/replay`
- **THEN** 返回 run/steps 摘要与 timeline（审计、receipt、证据引用等）
- **AND** 不包含可用于重放写入的明文 payload

#### Scenario: Replay 不触发执行
- **WHEN** 调用 `GET /runs/:runId/replay`
- **THEN** 不触发任何 tool 执行、队列入队、外部网络出站、数据库写入业务副作用
- **AND** 仅允许写入“回放被访问”的审计事件（摘要）

### Requirement: Re-exec 真实重执行（新 run/step + 可追溯关联）
系统 SHALL 将 Re-exec 定义为“重新执行工作流”的写操作：必须创建新的 run/step，生成新的幂等键/关联字段，并记录 `reexec_of_run_id` 形成链路追溯。

#### Scenario: Re-exec 生成新 run
- **WHEN** 调用 `POST /runs/:runId/reexec`
- **THEN** 创建新 runId（不复用原 runId）
- **AND** 产生新的 idempotencyKey/请求关联字段（不得复用原执行的幂等键）
- **AND** 新 run 记录 `reexec_of_run_id = <originalRunId>`
- **AND** 写入审计事件 `workflow:reexec`（仅摘要）

## MODIFIED Requirements
### Requirement: Replay 与 Re-exec 语义区分
系统 SHALL 保证 Replay 与 Re-exec 在 API 层面与执行层面语义不可混淆：
- Replay：只读、不可产生外部副作用
- Re-exec：写操作、新 run/step、可产生外部副作用（仍受审批与幂等规则约束）

## REMOVED Requirements
（无）

