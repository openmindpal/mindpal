# Workflow Step Compensation（撤销/补偿与 UndoToken）V1 Spec

## Why
`架构-07-工作流与自动化-审批队列幂等.md` 明确要求对高风险操作提供撤销/补偿能力：在失败、误操作或合规回滚场景下，平台需要能够在**可审计、可授权、可回放**的前提下执行补偿动作，避免只能依赖人工数据库修复或不可追责的旁路操作。

当前工作流具备审批、队列、重试与死信，但缺少对“工具副作用”的结构化补偿语义与受控触发入口。V1 先落地最小闭环：**捕获 UndoToken** + **治理侧触发补偿工具** + **审计串联**。

## What Changes
- Step 记录补偿信息（V1）
  - 当 `tool.execute` step 成功返回包含 `undoToken`（或等价补偿 payload）时，将其写入 step 的补偿字段（单独字段或 JSONB）
  - 保持 `steps.output` 仍为安全展示字段；补偿 payload 视为敏感内容（不写入普通日志）
- 新增治理端补偿 API（V1）
  - `POST /governance/workflow/steps/:stepId/compensate`
  - 仅允许具备权限的主体触发，并进行 tenant/space scope 校验
  - 补偿执行通过“补偿工具（compensating toolRef）”完成，输入包含 `undoToken` 与必要上下文摘要
- 审计不可跳过（V1）
  - 触发补偿与补偿执行结果写入审计事件（success/denied/error），并与原 step/run 关联
- 兼容性
  - 历史 step 无补偿字段时保持原行为
  - 不要求所有工具都提供补偿；没有补偿信息则拒绝补偿请求

## Impact
- Affected specs:
  - 工作流与自动化（补偿/撤销语义）
  - 审计域（补偿行为追责）
  - 认证与授权（新增治理动作权限）
  - Skill 运行时（补偿工具的受控执行）
- Affected code:
  - DB：steps 表或新表存储补偿信息
  - Worker：捕获 undoToken 并持久化
  - API：治理端补偿 endpoint + 权限接入 + 审计写入

## ADDED Requirements

### Requirement: PersistUndoTokenV1
系统 SHALL 在 step 成功执行后持久化补偿信息：
- **WHEN** `jobType=tool.execute` 的 step 成功，且工具输出包含 `undoToken`
- **THEN** 系统在该 step 记录中保存 `undoToken`（作为敏感字段对待）
- **AND** `steps.output` 不得包含 `undoToken`

#### Scenario: 有 undoToken 的 step 可用于后续补偿
- **WHEN** step 已保存 `undoToken`
- **THEN** 治理侧可在受控权限与 scope 校验下触发补偿

### Requirement: GovernanceStepCompensateApiV1
系统 SHALL 提供治理端接口触发补偿：
- Endpoint：`POST /governance/workflow/steps/:stepId/compensate`
- 鉴权：必须通过 RBAC/Policy，action 建议为 `workflow.step.compensate`
- Scope：必须满足 tenant/space 访问约束（不得跨 space 使用 undoToken）

#### Scenario: 有权限且 step 可补偿时成功触发
- **WHEN** 具备权限的主体对可补偿 step 发起 compensate
- **THEN** 系统调用补偿工具执行补偿
- **AND** 写入审计事件（result=success）

#### Scenario: step 无补偿信息时拒绝
- **WHEN** step 无 `undoToken` 或无对应补偿工具引用
- **THEN** 系统返回明确错误码（例如 `STEP_NOT_COMPENSABLE`）

### Requirement: AuditCompensationEventsV1
系统 SHALL 为补偿动作写入审计事件：
- action：`workflow.step.compensate`
- outputDigest：至少包含 stepId/runId/toolRef、是否命中 undoToken、执行结果摘要
- 不得包含明文敏感补偿 payload

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

