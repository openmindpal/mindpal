# Orchestrator 闭环执行落地 + Media 处理流水线去占位 V1 Spec

## Why
当前 `/orchestrator/closed-loop` 的执行阶段固定返回 `no_executor_configured`，导致“检索→风控→执行”闭环无法形成最小可用能力。同时 `media.process` 仍为 MVP 占位实现，仅写入衍生物记录而无实际处理产物，无法支撑后续治理与工作流编排。

## What Changes
- Orchestrator：为 `/orchestrator/closed-loop` 增加可配置 executor，默认提供一个“单步工具执行”执行器，实现最小闭环能力，不再返回 `no_executor_configured`
- Orchestrator：执行阶段与审计/权限/工具治理对齐，复用现有 `/orchestrator/execute` 的安全约束（工具启用、输入校验、网络策略、幂等键等）
- Media：将 `media.process` 从“仅写占位 derivatives”升级为“按 op 产出真实衍生物/失败摘要”的处理器
  - 内置实现：`extractText`（文本类 contentType）、`thumbnail`（图片类 contentType）
  - 可插拔实现：`transcode`、`transcript` 通过“外部处理器/工具”挂载（缺省可明确失败，并记录稳定错误摘要）
- Media：衍生物持久化方式从“meta 占位”升级为“可追溯的产物引用”，优先使用现有 artifact 体系挂载（如果仓库已有对应写入路径），否则以受控方式存储并返回可解释 meta

## Impact
- Affected specs:
  - Orchestrator Contract（闭环执行与审计/权限）
  - Media Contract（处理流水线从 MVP 占位升级）
  - Tool Governance / Network Policy（闭环执行需要与工具治理一致）
- Affected code:
  - API：`apps/api/src/routes/orchestrator.ts`
  - API：`apps/api/src/modules/orchestrator/*`（如需要抽取 executor）
  - Worker：`apps/worker/src/media/processor.ts`
  - API/Worker：media 的存储/artifact 读写辅助模块（仅在必要时新增）

## ADDED Requirements
### Requirement: Closed-Loop Executor（最小闭环）
系统 SHALL 为 `/orchestrator/closed-loop` 提供可配置的 executor，并在 guard.allow 的情况下执行至少一个可验证的动作，而不是返回 `no_executor_configured`。

#### Scenario: 允许执行且有可执行动作
- **WHEN** 用户调用 `/orchestrator/closed-loop` 且 guard.allow=true
- **AND** 系统能够从 goal+evidence 得到至少一个“允许执行”的动作（工具已启用、无需审批、输入校验通过）
- **THEN** `execution.status` 为 `queued|succeeded|failed`
- **AND** `execution` 包含稳定摘要（toolRef、idempotencyKey、stepRef/runRef 的 digest），不得包含敏感输入明文

#### Scenario: 无可执行动作
- **WHEN** 用户调用 `/orchestrator/closed-loop` 且 guard.allow=true
- **AND** 系统未能生成可执行动作
- **THEN** `execution.status` 为 `skipped`
- **AND** `execution.reason` 为稳定枚举（例如 `no_action` / `all_actions_blocked`）

#### Scenario: 需要审批
- **WHEN** 用户调用 `/orchestrator/closed-loop` 且 guard.allow=false 且 approvalRequired=true
- **THEN** `execution.status` 为 `blocked`
- **AND** `execution.reason` 为 `approval_required`

### Requirement: Closed-Loop 执行与治理对齐
系统 SHALL 在 closed-loop executor 阶段对齐现有执行链路的治理与安全约束：
- 工具是否启用（Tool Governance）
- 工具输入校验（Tool contract validate）
- 网络策略（Tool Network Policy）
- 幂等键（idempotencyKey）与审计写入（resourceType=orchestrator, action=closed_loop）

#### Scenario: 工具被禁用
- **WHEN** executor 选择的 toolRef 被治理禁用
- **THEN** 执行 SHALL 被拒绝，`execution.status=skipped|failed` 且 `reason=tool_disabled`

### Requirement: Media Process 产出真实衍生物（不再是 mvp 占位）
系统 SHALL 在 `media.process` 中对支持的 op 产出真实可引用的衍生物结果；对于不支持的 op/类型，必须返回稳定失败摘要，而不是写入 `meta: { mvp: true }` 的成功占位记录。

#### Scenario: extractText（文本类）
- **WHEN** MediaObject 的 `contentType` 为 `text/plain` 或 `application/json` 等文本可解析类型
- **AND** job.ops 包含 `extractText`
- **THEN** 生成 `media_derivatives(kind=extractText, status=succeeded)`，并包含产物引用（优先 artifactId）与 `meta.textDigest`

#### Scenario: thumbnail（图片类）
- **WHEN** MediaObject 的 `contentType` 为 `image/png|image/jpeg|image/webp`
- **AND** job.ops 包含 `thumbnail`
- **THEN** 生成 `media_derivatives(kind=thumbnail, status=succeeded)`，并包含产物引用（优先 artifactId）与 `meta.dimensionsDigest`

#### Scenario: 不支持的 op 或类型
- **WHEN** job.ops 包含 `transcript`/`transcode` 但系统未配置外部处理器
- **OR** contentType 不在该 op 支持列表中
- **THEN** 生成 `media_derivatives(kind=<op>, status=failed)` 或更新 job 为 failed（由实现选择其一，但必须一致）
- **AND** `error_digest`/`meta.errorDigest` 包含稳定错误码（例如 `MEDIA_OP_NOT_SUPPORTED` / `MEDIA_PROCESSOR_NOT_CONFIGURED`）

## MODIFIED Requirements
### Requirement: Media Process 的成功语义收紧
系统 SHALL 将 `media.process` 的成功语义从“写占位记录”收紧为“实际产出可引用衍生物”；成功时不得使用 `meta: { mvp: true }` 作为唯一结果。

### Requirement: Orchestrator Closed-Loop 的执行阶段不再是占位
系统 SHALL 移除 `execution.reason=no_executor_configured` 的默认行为；如执行能力不可用，必须以可解释方式返回 `skipped` 且给出稳定原因。

## REMOVED Requirements
无
