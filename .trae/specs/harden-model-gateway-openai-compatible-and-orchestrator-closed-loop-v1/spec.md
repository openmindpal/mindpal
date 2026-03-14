# Model Gateway OpenAI-Compatible Provider 覆盖与 Closed-Loop 编排对齐 Spec

## Why
当前 Model Gateway 存在 `PROVIDER_NOT_IMPLEMENTED` 兜底路径，且 `/models/onboard` 已暴露多个 OpenAI 兼容提供方键（deepseek/hunyuan/qianwen…），但运行期 provider 覆盖与错误语义不够“契约化”。与此同时 `/orchestrator/closed-loop` 仍以“预制 plan + 仅特定输入形态触发执行”为主，未充分对齐《架构设计.md》15.1 的 plan-and-execute 与错误分类/恢复要求。

## What Changes
- Model Gateway
  - Provider 独立化：`openai_compatible` 作为独立 provider；`deepseek`、`hunyuan`、`qianwen`、`zhipu`、`doubao`、`kimi`、`kimimax` 均作为独立 provider（不再以 providerKey 方式折叠到 `openai_compatible`）
  - `/models/catalog` 将上述 provider 作为一等条目/模板输出，并明确各自的 `modelRef` 命名规则与 baseUrl 规范化规则
  - `/models/onboard` 改为接收 `provider`（不再接收 `providerKey`），并将创建的 binding 记录 provider 写为所选 provider；审计摘要包含 `{ provider, endpointHost }`（不含密钥）
  - `/models/chat` 对上述 provider 显式分支处理：可复用同一套 OpenAI-Compatible adapter，但 provider 仍保持各自独立，用于审计、配额、路由与错误语义
  - `PROVIDER_NOT_IMPLEMENTED` 仅作为“代码未实现该 provider adapter”的稳定语义；对“输入非法/不允许的 provider”返回 `MODEL_PROVIDER_UNSUPPORTED`（400），不得用字符串 reason 兜底
- Orchestrator Closed-Loop
  - `/orchestrator/closed-loop` 支持“自然语言 goal → 计划 → 受控执行”的最小闭环：不再要求 goal 必须是 JSON 动作包
  - 提供 `continue` 能力：基于已持久化的 plan/task_state 光标，在审批通过或用户确认后继续推进下一步（直到达到 maxSteps 或进入 needs_approval/failed）
  - 强化错误分类：对 policy_violation / upstream_error / executor_error / rate_limited 等稳定分类写入 task_state 与审计 digest，便于恢复与运营

## Impact
- Affected specs: 模型网关（路由/限流/配额/审计）、编排层（计划与执行循环）、工作流/审批（needs_approval）、记忆层（task_states 持久化）
- Affected code:
  - API：models 路由与 modelGateway 模块、orchestrator 路由
  - Worker：不需要为每个 provider 新增独立 adapter（允许复用 OpenAI adapter），但需要确保 usage/audit 以 provider 维度准确归集
  - 数据迁移：需要对历史 `model_bindings` 的 provider/modelRef 进行兼容与迁移（见下方 Migration）

## ADDED Requirements

### Requirement: 模型 Provider 独立化（OpenAI-Compatible 家族）
系统 SHALL 将 `openai_compatible`、`deepseek`、`hunyuan`、`qianwen`、`zhipu`、`doubao`、`kimi`、`kimimax` 作为相互独立的 provider，并在绑定、调用、审计与统计中保持一致的 provider 语义。

#### Scenario: Onboard 创建独立 Provider 绑定
- **WHEN** 用户调用 `POST /models/onboard` 且 `provider` 属于允许集合（`openai_compatible`、`deepseek`、`hunyuan`、`qianwen`、`zhipu`、`doubao`、`kimi`、`kimimax`）
- **THEN** 系统创建/复用 connectorInstance 与 secret，并创建 binding：
  - `binding.provider` = 请求指定的 provider
  - `binding.baseUrl` 为规范化后的 OpenAI 兼容 baseUrl（不含 `/v1` 尾缀）
  - 审计摘要包含 `provider` 与 `endpointHost`，但不包含 `apiKey` 明文
  - `modelRef` 命名遵循：`{provider}:{modelName}`（其中 provider 为上述之一）

#### Scenario: Chat 调用独立 Provider
- **WHEN** `POST /models/chat` 路由选择到 provider 属于（`openai_compatible`、`deepseek`、`hunyuan`、`qianwen`、`zhipu`、`doubao`、`kimi`、`kimimax`）的 binding
- **THEN** 系统使用 OpenAI-Compatible adapter 通过 `binding.baseUrl` 调用上游，并：
  - 仍执行 allowedDomains 白名单校验（基于 baseUrl host）
  - 在 `attempts[]` 中记录 `modelRef/status/errorCode`，成功时输出 `outputText`
  - 失败时对上游错误映射为稳定错误码（如 `MODEL_UPSTREAM_FAILED`），并在审计中标记 `errorCategory=upstream_error`
  - 计量/usage 归集与审计事件中的 `provider` 必须等于 binding.provider（不得回退为 `openai_compatible` 或其他折叠值）

### Requirement: Provider 未实现的稳定失败语义
系统 SHALL 对“可识别但未实现的 provider adapter”返回稳定错误码 `PROVIDER_NOT_IMPLEMENTED`（501）。对“非法/不允许的 provider”返回稳定错误码 `MODEL_PROVIDER_UNSUPPORTED`（400）。两者都必须在审计 attempts 中以稳定 errorCode 记录，不得仅依赖不稳定的字符串 reason。

### Requirement: 绑定与 modelRef 的迁移兼容
系统 SHALL 提供对历史绑定的迁移兼容：
- 若存在历史 `modelRef` 形如 `openai_compat:{providerKey}:{modelName}`，系统 MUST 可迁移为 `{providerKey}:{modelName}`，并将 binding.provider 更新为 `{providerKey}`
- 迁移期间允许读路径兼容旧 `modelRef`，但新写入（onboard/bind）不得再生成旧格式
  
#### Migration
- 对历史 `model_bindings`（或等价表）执行一次性迁移：解析旧 `modelRef` 前缀 `openai_compat:`，提取 providerKey 与 modelName，并更新：
  - `provider = providerKey`
  - `modelRef = providerKey:modelName`
  - `model = modelName`
- 迁移过程必须写审计摘要（仅记录受影响行数与 provider 分布，不记录密钥或 baseUrl 明文）

## MODIFIED Requirements

### Requirement: Orchestrator Closed-Loop 执行闭环
系统 SHALL 将 `/orchestrator/closed-loop` 从“演示闭环”升级为“可运行的最小 plan-and-execute 闭环”，并将计划与推进光标持久化到 `memory_task_states`，以支持恢复执行。

#### Scenario: 自然语言 goal 生成可执行计划
- **WHEN** 用户调用 `POST /orchestrator/closed-loop` 提供 `goal`（自然语言）
- **THEN** 系统调用编排器生成 tool suggestions，并产出 plan：
  - plan.steps 至少包含可执行 tool 步骤（已发布且已启用的 toolRef）
  - 若无可执行步骤，返回稳定错误码 `ORCH_PLAN_EMPTY`（并写审计）

#### Scenario: 推进与审批闸门
- **WHEN** plan 中下一步 `approvalRequired=true`（或 riskLevel=high）
- **THEN** 系统创建审批并将 execution 标记为 `blocked/approval_required`，不再继续推进后续步骤

#### Scenario: Continue 继续推进
- **WHEN** 用户调用 `POST /orchestrator/closed-loop/continue` 并提供 `runId`
- **THEN** 系统从 `memory_task_states` 恢复 plan 与光标，追加/入队下一步 step；若达到 `maxSteps` 或 `maxWallTimeMs` 则停止并返回 `stopped` 状态摘要

## REMOVED Requirements

### Requirement: Closed-Loop 仅支持 JSON 动作包触发执行
**Reason**: 限制了闭环入口，导致“自然语言 goal”无法生成可执行计划。  
**Migration**: 继续支持 `{toolRef,input,idempotencyKey}` 的 JSON goal 作为兼容输入；但默认路径改为自然语言 → plan → 执行。  
