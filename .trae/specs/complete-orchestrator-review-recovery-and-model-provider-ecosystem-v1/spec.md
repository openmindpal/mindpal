# AI 编排闭环补全与模型提供方生态暴露 Spec

## Why
当前 AI 编排层的 closed-loop 更接近“建议生成 + 受控执行”，缺少更强的“计划-执行-复核”状态机与错误恢复策略，导致任务推进、失败处理与可回放评测绑定不够稳健。同时，模型提供方能力虽已支持 openai_compatible 形态，但对外暴露的 Catalog 仍偏静态，易造成“生态未铺开”的误解与接入摩擦。

## What Changes
- Orchestrator closed-loop：补齐“计划-执行-复核”状态机与可恢复推进语义（包括失败分类、重试/跳过/终止决策）
- Orchestrator closed-loop：增强工具选择/约束表达（允许调用方传入约束边界，运行时强制落到治理启用与网络策略）
- Orchestrator ↔ Replay/Eval：在闭环执行产物中补齐可回放与评测所需的稳定引用（plan/attempts/step 输入摘要与关键决策摘要）
- Model Gateway：增强 /models/catalog 的“生态暴露”，新增 openai_compatible 相关模板信息与稳定的 provider 未实现语义（不破坏现有返回字段）

## Impact
- Affected specs: 架构-08（AI 编排层）、架构-09（模型网关）
- Affected code:
  - API: apps/api/src/routes/orchestrator.ts, apps/api/src/modules/orchestrator/*, apps/api/src/modules/memory/*, apps/api/src/modules/workflow/*
  - API: apps/api/src/routes/models.ts, apps/api/src/modules/modelGateway/*
  - Tests: apps/api/src/__tests__/e2e.test.ts

## ADDED Requirements
### Requirement: Orchestrator closed-loop 状态机（计划-执行-复核）
系统 SHALL 为 `/orchestrator/closed-loop` 运行引入明确的阶段与步骤状态，并可在中断后继续推进。

#### Scenario: Start → Plan → Execute（成功推进）
- **WHEN** 用户调用 `POST /orchestrator/closed-loop` 提交 goal
- **THEN** 系统生成 plan（含步骤列表）并持久化到 task_state（或等价持久化体）
- **AND** 系统创建并推进第一个可执行步骤（直接入队或进入审批阻塞）
- **AND** 返回稳定的 execution 摘要（phase、cursor、nextAction、runId、首步状态摘要）

#### Scenario: Execute → Review（复核阶段）
- **WHEN** 本轮步骤执行完成（success / failed / blocked）
- **THEN** 系统进入 reviewing 或可判定的终态（succeeded/failed/stopped/needs_approval）
- **AND** 复核产物必须包含：本轮执行步骤摘要、工具引用（toolRef）、入参/出参摘要（digest）、关键拒绝/失败原因（errorCode + category）

#### Scenario: Continue（中断后恢复推进）
- **WHEN** 用户调用 `POST /orchestrator/closed-loop/continue` 并提供 runId（以及可选限制）
- **THEN** 系统从持久化的 cursor/phase 恢复推进
- **AND** 遵守 maxSteps/maxWallTimeMs，并输出稳定的推进结果摘要

### Requirement: Orchestrator closed-loop 错误恢复策略
系统 SHALL 对失败进行可解释分类，并提供最小集合的恢复动作。

#### Scenario: Retryable error（可重试错误）
- **WHEN** 步骤失败且 errorCategory 属于 upstream_error / transient
- **THEN** 系统将该步骤标记为 retryable
- **AND** `continue` 或显式 retry 操作可在不破坏幂等的前提下重新执行（必须复用/生成稳定 idempotencyKey 策略并写入审计摘要）

#### Scenario: Policy violation（策略拒绝）
- **WHEN** 步骤失败且 errorCategory=policy_violation
- **THEN** 系统不得自动重试
- **AND** 必须提供 nextAction=blocked(approval_required 或 policy_denied) 的稳定输出

### Requirement: 工具选择与约束表达（智能化但最小实现）
系统 SHALL 支持调用方对闭环执行施加约束边界，并在运行时强制执行。

#### Scenario: Allow-list 限制
- **WHEN** 请求携带 constraints.allowedTools（tool name 或 toolRef）
- **THEN** 计划生成与执行均不得超出 allow-list
- **AND** 若无可用步骤，返回稳定错误 ORCH_PLAN_EMPTY（或等价错误码）

### Requirement: 回放/评测绑定所需引用信息
系统 SHALL 在闭环执行产物中补齐可回放解析所需字段，并使其与现有 replay 机制兼容。

#### Scenario: Replay resolve 可用
- **WHEN** 产生任一 tool step
- **THEN** 必须确保 run.policy_snapshot_ref、step.tool_ref、step.input_digest 可用于 `/replay/resolve` 定位历史执行
- **AND** task_state（或等价持久化体）必须保存 plan 与 steps 的摘要（不含敏感明文）

## MODIFIED Requirements
### Requirement: /models/catalog 生态暴露（非破坏性扩展）
系统 SHALL 在保持现有 `{ catalog: [...] }` 结构的同时，新增可选字段用于暴露 openai_compatible 的接入模板信息。

#### Scenario: Catalog includes templates（新增字段）
- **WHEN** 用户调用 `GET /models/catalog`
- **THEN** 仍返回 `catalog`（现有静态列表不变）
- **AND** 额外返回 `templates.openaiCompatible`（或等价命名），包含：
  - 支持的 providerKey 列表（与 `/models/onboard` 入参校验保持一致）
  - modelRef 建议格式（例如 `openai_compat:{providerKey}:{modelName}`）
  - baseUrl 规范化规则摘要（不含敏感信息）

### Requirement: Provider 未实现语义稳定化
系统 SHALL 在 /models/chat 路由候选中遇到未实现/不支持 provider 时，优先记录 attempts 为 skipped 并继续尝试其他候选；仅当所有候选均不可用时，返回稳定错误码且审计摘要包含 attempts 统计。

