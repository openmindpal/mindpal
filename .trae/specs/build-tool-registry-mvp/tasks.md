# Tasks
- [x] Task 1: 设计并落地 Tool Registry 数据模型与迁移
  - [x] SubTask 1.1: 定义 tool_definitions/tool_versions 最小字段集合（含 i18n）
  - [x] SubTask 1.2: 定义 toolRef 命名与版本规则（name@version + 依赖摘要占位）
  - [x] SubTask 1.3: 添加迁移并保证可重复执行

- [x] Task 2: 实现 Tool Registry API（注册/发布/查询）
  - [x] SubTask 2.1: 实现工具列表与单个工具查询（含版本）
  - [x] SubTask 2.2: 实现发布接口（写入版本并校验 schema 合法性）
  - [x] SubTask 2.3: 接入 AuthZ（resourceType=tool）与审计（成功/拒绝/失败）

- [x] Task 3: 实现受控工具执行入口（API 创建 Run/Step 并入队）
  - [x] SubTask 3.1: 定义执行请求契约（toolRef、input、idempotencyKey、可选 scope）
  - [x] SubTask 3.2: 实现 /tools/:toolRef/execute（或等价）创建 job/run/step 并 enqueue
  - [x] SubTask 3.3: 记录 policySnapshotRef/toolRef/inputDigest 到 run/step 与审计

- [x] Task 4: 扩展 worker 支持最小内置工具集执行
  - [x] SubTask 4.1: 增加通用 toolRef 分发机制（白名单/注册表驱动）
  - [x] SubTask 4.2: 提供 1-2 个内置工具（例如 entity.create/entity.update 的 tool 化封装）
  - [x] SubTask 4.3: attempt 失败分类与重试策略对齐审计字段

- [x] Task 5: 提供执行回执/回放查询接口
  - [x] SubTask 5.1: 实现按 runId/stepId 查询执行摘要与 attempt 列表
  - [x] SubTask 5.2: 返回 inputDigest/outputDigest/toolRef/policySnapshotRef/status
  - [x] SubTask 5.3: 接入授权与审计

- [x] Task 6: 回归测试与文档补齐
  - [x] SubTask 6.1: 覆盖工具发布/查询/执行入队/worker 执行/回执查询
  - [x] SubTask 6.2: 覆盖禁止旁路直连数据库的策略断言（最小可测形式）
  - [x] SubTask 6.3: 更新 README：如何注册工具与触发执行

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 3
- Task 6 depends on Task 2, Task 3, Task 4, Task 5
