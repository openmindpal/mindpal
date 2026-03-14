# Tasks
- [x] Task 1: 初始化单仓工程骨架与依赖服务接入
  - [x] SubTask 1.1: 创建 apps/web、apps/api、apps/worker 与 packages/shared 结构
  - [x] SubTask 1.2: 接入本地依赖（Postgres/Redis/MinIO）配置与启动说明
  - [x] SubTask 1.3: 建立基础 CI/测试脚本（最少 lint + unit test 占位）

- [x] Task 2: 落地统一请求链路（API 层骨架）
  - [x] SubTask 2.1: 生成 traceId/requestId 并贯穿日志与审计
  - [x] SubTask 2.2: 建立标准错误模型（errorCode + i18n message）
  - [x] SubTask 2.3: 串联鉴权→校验→授权→执行→审计的中间件/管线
  - [x] SubTask 2.4: 落地语言解析优先级与默认 zh-CN（user>space>tenant>platform）

- [x] Task 3: 实现元数据平面（Schema Registry MVP）
  - [x] SubTask 3.1: 建立 Schema 存储结构（draft/released/deprecated + version）
  - [x] SubTask 3.2: 提供 Schema 获取/列表/发布接口
  - [x] SubTask 3.3: 实现基础兼容性检查（最小规则子集）
  - [x] SubTask 3.4: 为可展示字段提供 i18n 结构并定义回退规则

- [x] Task 4: 实现 AuthN/AuthZ（RBAC 资源级 MVP）
  - [x] SubTask 4.1: 建立 Subject + Tenant/Space 上下文解析与绑定
  - [x] SubTask 4.2: 实现 Role/Permission/Binding 与资源级决策输出
  - [x] SubTask 4.3: 输出可解释决策摘要与 Policy Snapshot 引用/摘要

- [x] Task 5: 实现审计域（append-only MVP）
  - [x] SubTask 5.1: 建立审计事件最小字段模型与存储（append-only）
  - [x] SubTask 5.2: 在 API 层确保成功/拒绝/失败都写审计
  - [x] SubTask 5.3: 提供基础审计检索接口（按 traceId/subject/action）

- [x] Task 6: 实现数据平面通用 CRUD（JSONB MVP）
  - [x] SubTask 6.1: 建立通用实体存储与 schemaRef 关联
  - [x] SubTask 6.2: 实现 Schema 校验、字段级写约束与字段级读裁剪
  - [x] SubTask 6.3: 实现写入幂等（idempotencyKey 去重）与并发控制占位

- [x] Task 7: 实现 Effective Schema 生成与缓存占位
  - [x] SubTask 7.1: 基于 Schema + 字段规则生成 Effective Schema
  - [x] SubTask 7.2: 提供 /schemas/:entity/effective 接口并支持缓存键设计占位

- [x] Task 8: 实现 Workflow/Queue（高风险写入异步框架 MVP）
  - [x] SubTask 8.1: 建立 Job/Run/Step/Artifact 的最小数据模型与状态机
  - [x] SubTask 8.2: 接入队列 worker（重试/退避/死信）并记录 attempt 审计
  - [x] SubTask 8.3: 打通“高风险写意图→进入队列→执行→回执”的端到端链路

- [x] Task 9: 实现 Web/UI MVP（Schema 驱动通用页面）
  - [x] SubTask 9.1: 获取导航/页面定义与 Effective Schema（占位可先固定）
  - [x] SubTask 9.2: 生成实体列表/详情/表单的最小可用交互
  - [x] SubTask 9.3: 写操作走统一 API 并携带 idempotencyKey
  - [x] SubTask 9.4: UI 按语言偏好渲染文案与 Schema 展示字段（默认中文）

- [x] Task 10: 端到端示例与验证
  - [x] SubTask 10.1: 提供示例 Schema（如 notes）与种子数据
  - [x] SubTask 10.2: 添加最小回归用例（授权拒绝、字段裁剪、幂等命中、审计落库）
  - [x] SubTask 10.3: 完善本地启动与验证步骤文档（不改变既有架构文档）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2
- Task 5 depends on Task 2
- Task 6 depends on Task 2, Task 3, Task 4
- Task 7 depends on Task 3, Task 4
- Task 8 depends on Task 2, Task 4, Task 5
- Task 9 depends on Task 2, Task 7
- Task 10 depends on Task 3, Task 4, Task 5, Task 6, Task 8, Task 9
