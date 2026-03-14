# Tasks
- [x] Task 1: 定义并实现 pipeline quota gate 的计算与输出
  - [x] SubTask 1.1: 设计 quota gate 的 status 规则与 detailsDigest 字段
  - [x] SubTask 1.2: 在 pipeline 路由中接入 quota gate 并补齐审计摘要

- [x] Task 2: 新增模型路由与工具并发的 space override 存储
  - [x] SubTask 2.1: 新增 DB migrations：routing_policies_overrides / tool_limits_overrides
  - [x] SubTask 2.2: 新增/扩展 repo：按 space 读取/写入/删除 override

- [x] Task 3: 扩展 ChangeSet canary 执行器覆盖 model_* 与 tool_limits.set
  - [x] SubTask 3.1: preflight：为可 canary 的 items 生成按 space 的 plan/current/rollback 摘要
  - [x] SubTask 3.2: release?mode=canary：写入 override；对不支持项返回稳定错误码
  - [x] SubTask 3.3: promote：写入全量配置并清理 override；rollback 语义保持幂等

- [x] Task 4: 运行时读取 effective 配置以匹配 canary 行为
  - [x] SubTask 4.1: /models/chat：按 space 读取 routing policy override（否则回退 tenant 默认）
  - [x] SubTask 4.2: tool 并发限制：按 space 读取 tool limit override（否则回退 tenant 默认）
  - [x] SubTask 4.3: quota_limits 的 canary 支持仅限 space scope（与 spec 一致）

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API e2e：canary preflight/release/promote/rollback 覆盖 model_routing/tool_limits/model_limits(space)
  - [x] SubTask 5.2: API e2e：pipeline quota gate 不再返回 not_implemented 且输出稳定摘要

# Task Dependencies
- Task 2 depends on Task 1 (quota gate 规则确定后更易复用摘要结构)
- Task 3 depends on Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 1, Task 3, Task 4
