# Tasks
- [x] Task 1: 补齐 Orchestrator closed-loop“计划-执行-复核”状态机
  - [x] SubTask 1.1: 定义并落地 phase/stepStatus 的持久化结构与稳定输出摘要
  - [x] SubTask 1.2: 扩展 /orchestrator/closed-loop 与 /continue 的推进逻辑，进入 reviewing/终态

- [x] Task 2: 增加错误恢复动作与约束执行
  - [x] SubTask 2.1: 实现失败分类（policy/upstream/validation/transient）与 retryable 判定
  - [x] SubTask 2.2: 增加最小恢复动作（retry/skip/stop），并写入审计摘要
  - [x] SubTask 2.3: 支持 constraints.allowedTools 等约束，计划与执行阶段均强制生效

- [x] Task 3: 补齐回放/评测绑定所需引用信息
  - [x] SubTask 3.1: 在闭环产物中补齐 replay 解析所需字段摘要（policySnapshotRef/toolRef/inputDigest/attempts）
  - [x] SubTask 3.2: 确保敏感信息不落日志/审计明文，仅记录 digest

- [x] Task 4: 模型提供方生态暴露与 provider 语义稳定化
  - [x] SubTask 4.1: /models/catalog 新增 openai_compatible 模板字段（非破坏性扩展）
  - [x] SubTask 4.2: /models/chat 遇到未实现 provider 时统一 attempts=skipped 并继续候选

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API e2e：closed-loop 成功推进 + reviewing/终态摘要稳定
  - [x] SubTask 5.2: API e2e：closed-loop 失败分类与恢复动作（policy 拒绝不重试、upstream 可重试）
  - [x] SubTask 5.3: API e2e：/models/catalog 返回 templates 字段；provider 未实现候选可被跳过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 5 depends on Task 1, Task 2, Task 3, Task 4
