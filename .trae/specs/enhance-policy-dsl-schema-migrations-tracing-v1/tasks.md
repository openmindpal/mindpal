# Tasks

* [x] Task 1: 设计并实现 Policy Expression DSL V1 与解释器

  * [x] 定义 DSL JSON Schema、类型与校验（禁止任意字段与操作符）

  * [x] 实现解释器：将 DSL 转为参数化 SQL 条件并与数据面查询拼接

  * [x] 将解释失败统一转为 deny + policy snapshot reason=unsupported\_policy\_expr

* [x] Task 2: 扩展授权引擎与 RBAC 管理面支持新 DSL

  * [x] authz 合并 rowFilters 时支持 expr 与旧规则共存

  * [x] RBAC API 支持写入/读取 expr 结构（含服务端校验）

  * [x] Web /admin/rbac 增加 rowFilters 编辑：模板表单 + 高级 JSON 编辑 + 预检

* [x] Task 3: 引入 Schema Migration 资源、执行作业与治理联动

  * [x] DB：新增 schema\_migrations、schema\_migration\_runs（含进度/状态/审计字段）

  * [x] API：新增迁移计划创建/查询/取消接口（治理权限保护）

  * [x] Worker：实现批处理 backfill 与 rename\_field\_dual\_write 执行器（可恢复/可重试）

  * [x] Governance：schema changeset preflight 增加 migration gate 摘要；release 增加 MIGRATION\_REQUIRED 校验

* [x] Task 4: 接入 OpenTelemetry 并打通 API→Queue→Worker trace 传播

  * [x] API：初始化 OTel SDK（Fastify/HTTP/PG/Redis instrumentations）与 OTLP exporter 配置

  * [x] API：入队时注入 trace 上下文到 job payload

  * [x] Worker：消费时提取上下文并创建 spans（关键阶段打点）

  * [x] 文档/示例：补充环境变量开关与本地验证方法

* [x] Task 5: 测试与验证

  * [x] 单测：DSL 校验与解释器（包含拒绝用例与注入防护）

  * [x] e2e：ABAC rowFilters 生效（结合 entities.query/list/get）

  * [x] e2e：schema publish gate（未迁移→拒绝；迁移成功→允许）

  * [x] 验证：开启 OTel 后可观察到 HTTP→Worker 的链路 span

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 1（migration gate 依赖策略快照/解释摘要结构稳定）

* Task 5 depends on Task 1, Task 2, Task 3, Task 4

