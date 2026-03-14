# Tasks
- [x] Task 1: 设计 Model Gateway V1 生产化扩展
  - [x] 明确 candidates/attempts 契约与错误分类（upstream_error/timeout/policy_violation）
  - [x] 明确熔断 key、阈值与 open/half-open 行为（最小实现）
  - [x] 明确用量归集字段与保留策略（仅摘要）

- [x] Task 2: 实现 Model Gateway 多候选路由与降级
  - [x] 从 constraints/purpose 解析候选 modelRef 列表并按序尝试
  - [x] 将每次尝试写入 outputDigest.attempts 摘要
  - [x] 覆盖：首选失败→次选成功、全部失败、policy_violation 不重试

- [x] Task 3: 实现 Model Gateway 熔断与可观测
  - [x] 在 upstream_error/timeout 时更新熔断计数并在 open 时跳过
  - [x] 增加熔断相关指标与诊断摘要（open 数、跳过次数）

- [x] Task 4: 实现模型用量/成本归集与治理查询
  - [x] 新增迁移：模型调用用量事件表与必要索引
  - [x] /models/chat 成功/失败路径写入归集事件（仅摘要）
  - [x] 新增治理只读 API：/governance/models/usage（聚合输出）

- [x] Task 5: 设计并落地 Skill 包信任策略
  - [x] 定义 manifest.signature 结构与验证口径（基于 depsDigest 或等价摘要）
  - [x] 增加配置：受信公钥集合与可选 allowlist roots
  - [x] 生产环境默认拒绝未受信包，并写入可解释审计摘要

- [x] Task 6: 将动态 Skill 执行迁移到子进程沙箱
  - [x] 实现受控 IPC 协议（input/output 摘要、错误分类、超时）
  - [x] 保持现有 timeout/并发/出站治理语义一致
  - [x] 回归：内置工具与动态工具均可执行，异常路径一致

- [x] Task 7: 补齐可观测性与健康/诊断端点
  - [x] /metrics：新增 worker/队列/tool/model 指标（低基数标签）
  - [x] /healthz：返回 DB/Redis 连通性与版本信息
  - [x] /diagnostics：返回熔断/队列/错误计数摘要（需权限）

- [x] Task 8: 增加最小运维/管理 CLI
  - [x] 新增 CLI app（或 package）与最小命令集（只读/幂等）
  - [x] 实现：audit verify、models usage export、queue status、changeset status
  - [x] 文档：运行方式与安全注意（不输出敏感信息）

- [x] Task 9: 扩展 ABAC Row Filters V2 并贯穿数据面
  - [x] 扩展 rowFilters DSL 存储/解析与 authorize 合并（OR 语义）
  - [x] 数据层执行：get/list/query/export 强制注入对应 SQL 过滤
  - [x] 工具执行链路对齐：worker 的 entity.* 执行同样应用 rowFilters

- [x] Task 10: 测试与回归
  - [x] e2e：模型多候选降级、熔断跳过、用量归集与治理查询
  - [x] e2e：生产环境信任策略拒绝未受信 Skill
  - [x] e2e：ABAC Row Filters V2 两种新表达的读路径覆盖
  - [x] e2e：/healthz 与 /diagnostics 权限与输出稳定

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2
- Task 6 depends on Task 5
- Task 9 depends on Task 1
- Task 10 depends on Task 2, Task 3, Task 4, Task 6, Task 7, Task 8, Task 9
