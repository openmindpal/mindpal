# Tasks
- [x] Task 1: Model Gateway Provider 独立化与迁移兼容
  - [x] SubTask 1.1: 更新 provider/modelRef 规则与 /models/catalog 模板输出
  - [x] SubTask 1.2: 更新 /models/onboard：以 provider 入参创建 binding（不再使用 providerKey）
  - [x] SubTask 1.3: 更新 /models/chat：对独立 provider 显式分支处理并保证 usage/audit 归集一致
  - [x] SubTask 1.4: 数据迁移与兼容：将 openai_compat:{providerKey}:{modelName} 迁移为 {providerKey}:{modelName}
  - [x] SubTask 1.5: 更新/新增 e2e：覆盖 deepseek/hunyuan/qianwen/zhipu/doubao/kimi/kimimax 的最小成功与拒绝路径

- [x] Task 2: Orchestrator closed-loop 升级为最小 plan-and-execute 闭环
  - [x] SubTask 2.1: 基于 orchestrator tool suggestions 生成 plan 并持久化 task_state（含光标）
  - [x] SubTask 2.2: 推进执行：创建 step/队列或审批闸门，更新 task_state.phase
  - [x] SubTask 2.3: 新增 /orchestrator/closed-loop/continue 恢复推进（maxSteps/maxWallTimeMs）

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: API e2e：独立 provider（成功/allowedDomains 拒绝/上游失败映射/迁移兼容）
  - [x] SubTask 3.2: API e2e：closed-loop 自然语言 goal → plan → queued/needs_approval，以及 continue

# Task Dependencies
- Task 3 depends on Task 1, Task 2
