# Workflow Step Payload Retention（Step 入参/出参密文留存与清理）V1 Spec

## Why
平台已将 `tool.execute` 的 step 入参/出参以 envelope.v1 加密落库，降低明文泄露面，但“密文长期留存”仍会带来风险与合规成本（敏感数据生命周期不可控、数据面暴露面积扩大、备份/恢复与审计导出的潜在包含面变大）。

按照 `架构设计.md` 的“默认安全 + 可治理 + 可运营”原则，需要在工作流层引入**可配置的留存策略**，在不破坏回放/追责能力的前提下，对 step 的加密 payload 进行按期清理，保留必要的元信息与摘要用于可解释审计与回放。

## What Changes
- 增加 step payload 留存策略（V1：按 tenant 全局配置，后续可扩展到 space）
  - 新增配置项：`workflow.stepPayloadRetentionDays`（默认值建议：7；0 表示不留存，立即清理；null/未配置表示使用默认）
  - 仅影响 `steps.input_encrypted_payload` 与 `steps.output_encrypted_payload`（不影响 steps.input/output 的最小元信息与摘要字段）
- 新增 worker 定时清理任务（V1）
  - 周期性扫描已完成 step（例如 status in succeeded/failed/canceled）
  - 对超过留存期限的记录，将 `input_encrypted_payload/output_encrypted_payload` 置空，并保留 `*_enc_format/*_key_version` 作为“历史加密格式标记”（或一并置空，按实现选择）
  - 清理操作写入审计事件（聚合写入，避免逐条爆炸）
- API 行为保持兼容（V1）
  - 无论是否已清理，常规 runs/steps 列表接口仍返回最小展示字段（现有行为）
  - 治理侧 reveal（如已实现）：
    - 若密文已被清理，则返回明确错误码（例如 `STEP_PAYLOAD_EXPIRED` 或复用 `STEP_OUTPUT_NOT_ENCRYPTED`，以规范为准）

## Impact
- Affected specs:
  - 工作流与自动化（留存与清理策略）
  - 审计域（清理行为可追责）
  - 治理控制面（配置项治理，V1 仅 API 级别配置，不强制 UI）
- Affected code:
  - Worker：新增定时清理逻辑（或复用现有 tick/cron 模式）
  - DB：可能新增 settings/config 存储（若现有 settings 已覆盖则复用）
  - API：如需暴露配置读写（治理权限控制）

## ADDED Requirements

### Requirement: StepPayloadRetentionConfigV1
系统 SHALL 支持配置 step 加密 payload 的留存天数 `workflow.stepPayloadRetentionDays`：
- 默认值：7 天（若未配置）
- 值域：0..365（超出拒绝）
- 生效范围：tenant 全局（V1）

#### Scenario: 配置为 0 天立即清理
- **WHEN** `workflow.stepPayloadRetentionDays=0`
- **THEN** worker 清理任务对已完成 step 应尽快清理密文 payload
- **AND** 不影响 runs/steps 的最小展示字段与摘要

### Requirement: StepPayloadPurgeJobV1
worker SHALL 周期性清理超过留存期限的加密 payload：
- 仅清理 `steps.input_encrypted_payload` 与 `steps.output_encrypted_payload`
- 清理后保留 `steps.input_digest/output_digest` 等摘要字段

#### Scenario: 清理后无法再 reveal 明文
- **WHEN** step 的密文 payload 已被清理
- **THEN** reveal 接口不得返回明文
- **AND** 返回明确错误码（例如 `STEP_PAYLOAD_EXPIRED`）

### Requirement: AuditPurgeEventsV1
系统 SHALL 为清理任务写入审计事件（聚合写入）：
- resourceType=governance（或 workflow，按现有约定）
- action=workflow.step.payload.purge
- outputDigest 至少包含：清理计数、时间窗、影响范围（tenant/space）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

