# Tasks
- [x] Task 1: 审计域契约收口：高风险动作强制三元上下文
  - [x] SubTask 1.1: 在 `server.ts` 定义高风险动作判定与必填字段校验入口
  - [x] SubTask 1.2: 在 `audit.ts` 高风险路由写审计前统一注入/校验 `runId/stepId/policySnapshotRef`
  - [x] SubTask 1.3: 在 `auditRepo.ts` 增加缺失字段拒绝写入与稳定错误码映射

- [x] Task 2: 审计域分类与 SIEM 回填治理补强
  - [x] SubTask 2.1: 统一 `errorCategory` 枚举并贯穿 API 返回、落库、SIEM 导出
  - [x] SubTask 2.2: 调整 `028_audit_hashchain.sql` 与 `071_audit_outbox.sql`，确保 append-only 与 outbox 原子性语义
  - [x] SubTask 2.3: 增加 SIEM 回填重试阈值、DLQ 与告警触发字段及治理接口行为

- [x] Task 3: 模型网关 structured output 强校验
  - [x] SubTask 3.1: 在 `models.ts` 为 `/models/chat` 增加 `outputSchema` 入参与响应契约
  - [x] SubTask 3.2: 输出不满足 schema 时返回稳定错误码并写审计摘要（无敏感明文）
  - [x] SubTask 3.3: 补齐 `models.ts` 现有未实现分支的可解释 attempts 摘要

- [x] Task 4: 模型路由策略发布准入与限流维度扩展
  - [x] SubTask 4.1: 将“路由策略变更→回归评测→发布”设为发布门槛并产出拒绝原因
  - [x] SubTask 4.2: 调整 `074_model_usage_events.sql` 与 `083_model_budgets.sql` 支撑 user/scene 维度统计
  - [x] SubTask 4.3: 在 `models.ts` 扩展 user/scene 维度限流命中与可观测摘要

- [x] Task 5: 测试与回归验收
  - [x] SubTask 5.1: 补充/更新 `hashchain.test.ts`，验证 append-only 与错误分类一致性
  - [x] SubTask 5.2: 扩展 e2e 审计段：高风险三元字段强制、outbox 失败回滚、SIEM test/backfill/dlq 回放
  - [x] SubTask 5.3: 扩展 e2e model gateway：structured output、评测准入门槛、user/scene 限流与预算硬上限
  - [x] SubTask 5.4: 全量运行 API 测试并修复回归问题

# Task Dependencies
- Task 2 depends on Task 1
- Task 4 depends on Task 3
- Task 5 depends on Task 2, Task 3, Task 4
