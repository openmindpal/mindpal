# Tasks
- [x] Task 1: 落地安全策略对象版本化与统一决策入口
  - [x] SubTask 1.1: 在 `dlp.ts` 定义可版本化策略对象与回退读取逻辑
  - [x] SubTask 1.2: 在 `promptInjection.ts` 与 `promptInjectionGuard.ts` 对齐统一策略输入结构
  - [x] SubTask 1.3: 在 `server.ts` DLP hook 接入策略版本解析并输出一致 safetySummary

- [x] Task 2: 统一四入口拒绝响应与审计摘要
  - [x] SubTask 2.1: model/tool/orchestrator/channel 四入口统一返回 `ruleId` 摘要
  - [x] SubTask 2.2: 校验 `audit_only` 仅脱敏不拒绝、`deny` 按 target 生效
  - [x] SubTask 2.3: 确保审计不落 token/key 明文

- [x] Task 3: 元数据兼容 gate 补强
  - [x] SubTask 3.1: 在 `compat.ts` 增加 deprecated/移除窗口校验规则
  - [x] SubTask 3.2: 在 `schemaRepo.ts` 与 `schemas.ts` 增加扩展命名空间校验
  - [x] SubTask 3.3: 不兼容字段变更统一返回可解释 gate 拒绝原因

- [x] Task 4: Effective Schema 缓存与失效机制
  - [x] SubTask 4.1: 在 `effectiveSchema.ts` 与 `schemaRepo.ts` 增加版本/快照维度缓存键
  - [x] SubTask 4.2: 实现 active 切换与快照变更的缓存失效
  - [x] SubTask 4.3: 验证缓存命中与失效行为稳定

- [x] Task 5: active/rollback 治理管道统一
  - [x] SubTask 5.1: 将 active/rollback 操作限制为 changeset 发布流程触发
  - [x] SubTask 5.2: 非治理直改路径返回稳定错误语义
  - [x] SubTask 5.3: 对齐审计摘要与治理状态回显

- [x] Task 6: 测试与回归
  - [x] SubTask 6.1: 扩展 e2e dlp 与 e2e prompt injection 覆盖四入口一致执行
  - [x] SubTask 6.2: 扩展 e2e schema/effective 覆盖 gate 拦截、active 生效与缓存失效
  - [x] SubTask 6.3: 运行 API 测试并修复回归

# Task Dependencies
- Task 2 depends on Task 1
- Task 4 depends on Task 3
- Task 5 depends on Task 3
- Task 6 depends on Task 2, Task 4, Task 5
