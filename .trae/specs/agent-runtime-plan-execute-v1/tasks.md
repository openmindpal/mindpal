# Tasks
- [x] Task 1: 定义 Agent Run 的 API 契约与权限模型
  - [x] 明确 endpoints（create/read/cancel/continue）与输入输出结构
  - [x] 明确所需 RBAC 权限（resourceType=agent_runtime）与审计字段
- [x] Task 2: 复用 Workflow Run 落库 Agent Run，并持久化 memory_task_states
  - [x] 创建 jobType=agent.run 的 job/run/step 创建路径
  - [x] 写入/更新 memory_task_states.phase/plan/artifacts_digest
  - [x] 向 Task Messages 追加 plan/observe/execute 等结构化消息
- [x] Task 3: 实现 V1 计划生成与最小执行循环
  - [x] 规划：从 orchestrator/工具注册表生成最小可执行 plan（V1 仅 tool 步骤）
  - [x] 执行：在同一 run 下按顺序创建 steps 并入队执行
  - [x] 边界：实现 maxSteps/maxWallTimeMs 与 stopped 状态
  - [x] 审批：遇到 approvalRequired 时进入 needs_approval 并停止推进
- [x] Task 4: 实现取消与恢复能力
  - [x] cancel：标记 run=canceled 并保证后续步骤不再执行
  - [x] continue：从 memory_task_states 读取 plan/光标继续推进（审批通过后可继续）
- [x] Task 5: 补齐测试与最小验证脚本
  - [x] API e2e：创建 run、读取 run、触发 needs_approval、取消、继续
  - [x] 回归：确认审计事件写入且不包含敏感明文

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 2, Task 3, Task 4
