# 审计域与模型网关补强 V2 Spec

## Why
当前 06 审计域与 09 模型网关已经具备主链路，但仍存在“部分完成”缺口。需要通过最小增量补强把关键治理能力提升到可稳定验收的“已完成”状态。

## What Changes
- 审计域：对高风险动作强制要求 `runId/stepId/policySnapshotRef`，并统一 `errorCategory` 枚举口径。
- 审计域：增强 SIEM 回填重试阈值、告警触发与可回放诊断链路。
- 模型网关：补齐 structured output 能力，对 `outputSchema` 做强校验并返回稳定错误语义。
- 模型网关：将“路由策略变更 → 回归评测 → 发布”固化为准入门槛，未通过不得发布。
- 模型网关：在限流上新增 user 维度与场景维度治理能力，并补充可观测摘要。
- **BREAKING**：高风险动作缺少 `runId/stepId/policySnapshotRef` 时将从“可通过”改为“拒绝执行”。

## Impact
- Affected specs: 审计域（append-only、SIEM 导出与回填）、模型网关（路由/限流/预算/评测准入）、治理控制面（发布门槛）。
- Affected code:
  - `apps/api/src/server.ts`
  - `apps/api/src/modules/audit/auditRepo.ts`
  - `apps/api/src/routes/audit.ts`
  - `apps/api/migrations/028_audit_hashchain.sql`
  - `apps/api/migrations/071_audit_outbox.sql`
  - `apps/api/src/routes/models.ts`
  - `apps/api/migrations/074_model_usage_events.sql`
  - `apps/api/migrations/083_model_budgets.sql`

## ADDED Requirements
### Requirement: 高风险审计上下文强制契约
系统 SHALL 在高风险动作写审计前强制校验 `runId`、`stepId`、`policySnapshotRef` 三元字段齐备；任一缺失必须拒绝执行并返回稳定错误码。

#### Scenario: 高风险动作上下文完整
- **WHEN** 高风险动作请求携带完整 `runId/stepId/policySnapshotRef`
- **THEN** 请求允许进入执行链路并写入完整审计记录

#### Scenario: 高风险动作上下文缺失
- **WHEN** 高风险动作请求缺少任一必需字段
- **THEN** 系统拒绝执行并返回可解释错误，且写入拒绝审计摘要

### Requirement: 审计错误分类统一枚举
系统 SHALL 统一 `errorCategory` 枚举并在 API、审计落库、SIEM 导出中保持一致。

#### Scenario: 错误路径分类一致
- **WHEN** 请求在任意失败路径终止
- **THEN** 返回体、audit_events、SIEM 载荷中的 `errorCategory` 一致且可聚合统计

### Requirement: SIEM 回填重试与告警闭环
系统 SHALL 支持可配置的回填重试阈值、重试间隔与告警触发，并提供 test/backfill/dlq 的可回放证据链路。

#### Scenario: 回填失败触发阈值
- **WHEN** SIEM 回填任务连续失败达到阈值
- **THEN** 任务进入 DLQ 并触发告警，同时可通过治理接口重放

### Requirement: 模型 Structured Output 强校验
系统 SHALL 在 `/models/chat` 支持 `outputSchema` 强校验；模型输出不符合 schema 时必须返回稳定错误码并写入审计摘要。

#### Scenario: 输出符合 schema
- **WHEN** 模型输出满足请求声明的 `outputSchema`
- **THEN** 返回结构化结果并记录成功尝试摘要

#### Scenario: 输出不符合 schema
- **WHEN** 模型输出与 `outputSchema` 不匹配
- **THEN** 返回结构化校验错误且不泄露敏感原文

### Requirement: 路由策略发布评测门槛
系统 SHALL 将模型路由策略变更绑定回归评测；评测未通过时禁止发布。

#### Scenario: 评测通过发布
- **WHEN** 路由策略变更绑定评测并全部通过
- **THEN** 允许发布并记录发布审计

#### Scenario: 评测未通过拦截
- **WHEN** 路由策略变更存在未通过评测
- **THEN** 发布被拒绝并返回明确拦截原因

### Requirement: user/场景维度限流
系统 SHALL 在 tenant 维度基础上增加 user 与场景维度限流能力，并输出可观测统计摘要。

#### Scenario: user 维度限流命中
- **WHEN** 单用户请求速率超过阈值
- **THEN** 返回限流错误并记录 user 维度命中统计

#### Scenario: 场景维度限流命中
- **WHEN** 特定场景请求速率超过阈值
- **THEN** 返回限流错误并记录场景维度命中统计

## MODIFIED Requirements
### Requirement: 审计 append-only 与 outbox 一致性
系统保留 append-only 约束：`audit_events` 禁止 update/delete；同时新增约束确保 outbox 写入失败时业务事务整体回滚，避免“业务成功但审计缺失”。

### Requirement: 模型网关可观测路由摘要
模型网关继续输出 candidates/attempts 摘要，并补充 structured output 校验结果、熔断/降级理由、预算与限流命中维度（tenant/user/scene）的稳定字段。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本次为补强与收口，不删除既有能力。
**Migration**: 不涉及迁移删除，仅涉及行为收紧与字段补全。
