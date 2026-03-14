# Tasks
- [x] Task 1: 定义 Pipeline Summary 读模型与 gates 口径
  - [x] SubTask 1.1: 明确 changeset/gates/rollout/rollbackPreviewDigest 字段与枚举
  - [x] SubTask 1.2: 明确 gates 与既有 preflight/eval/approvals/quota 的映射与优先级
  - [x] SubTask 1.3: 明确审计摘要字段与 i18n 错误码映射范围

- [x] Task 2: 实现发布流水线汇总 API（只读）
  - [x] SubTask 2.1: 新增/扩展 endpoint 返回 Pipeline Summary（按 changesetId）
  - [x] SubTask 2.2: 支持列表聚合（按状态/时间窗口分页）
  - [x] SubTask 2.3: 回归：权限与审计（读取也写审计或沿用既有规范）

- [x] Task 3: 发布流水线 UI（控制台）
  - [x] SubTask 3.1: changeset 列表页：状态过滤 + gate 徽标
  - [x] SubTask 3.2: changeset 详情页：preflight 摘要、评测状态、操作按钮（release/canary/promote/rollback）
  - [x] SubTask 3.3: 错误码→可操作提示（触发评测/补审批/调整配额等）

- [x] Task 4: 长任务中心读模型与汇总 API
  - [x] SubTask 4.1: 汇总 task + agent run + workflow run 的统一列表结构
  - [x] SubTask 4.2: 提供 run 详情：phase/plan 摘要、step 时间线、needs_approval 状态
  - [x] SubTask 4.3: 回归：权限边界与审计摘要不泄露敏感内容

- [x] Task 5: 长任务中心 UI（执行中心）
  - [x] SubTask 5.1: 长任务列表：过滤（space/subject/status/jobType）与快速操作（cancel/continue）
  - [x] SubTask 5.2: run 详情：计划/进度/事件流/审批提示与继续入口
  - [x] SubTask 5.3: 与现有执行中心/回放页面的导航整合（不重复造轮子）

- [x] Task 6: 回放与评测串联（最小闭环）
  - [x] SubTask 6.1: 从 run 创建 replay 的入口与参数校验（UI + API 复用既有能力）
  - [x] SubTask 6.2: 关联评测结果展示（可跳转到 EvalRun 或展示摘要）
  - [x] SubTask 6.3: 回归：审计与可观测指标补齐

- [x] Task 7: 操作手册与可观测性
  - [x] SubTask 7.1: 文档：发布流水线常见场景（失败门槛、回滚、canary/promote）
  - [x] SubTask 7.2: 文档：长任务中心（needs_approval、cancel/continue、回放与评测）
  - [x] SubTask 7.3: 指标：发布动作计数、门槛失败计数、长任务状态分布（最小集合）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 1
- Task 5 depends on Task 4
- Task 6 depends on Task 4, Task 5
- Task 7 depends on Task 2, Task 3, Task 4, Task 5, Task 6
