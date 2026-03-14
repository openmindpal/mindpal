# Tasks
- [x] Task 1: 设计并落地路由/配额/并发配置存储
  - [x] SubTask 1.1: 新增 migrations：routing_policies / quota_limits / tool_limits
  - [x] SubTask 1.2: 新增 repo 层：list/upsert/disable 与按 scope/toolRef 查询

- [x] Task 2: 实现治理 API（路由策略 + 配额并发）
  - [x] SubTask 2.1: 新增/扩展 governance routes：list/upsert/disable routing policies
  - [x] SubTask 2.2: 新增/扩展 governance routes：get/update modelChatRpm 与 defaultMaxConcurrency
  - [x] SubTask 2.3: 所有写操作写审计（outputDigest 摘要化）并做权限校验

- [x] Task 3: 改造 /models/chat 采用路由策略与配置化限流
  - [x] SubTask 3.1: 按 purpose 读取 routing policy 并计算候选链路
  - [x] SubTask 3.2: 对上游失败/超时触发 fallback；审计标记 fallback 触发原因
  - [x] SubTask 3.3: RPM 读取 DB 配置优先，回退 env 默认

- [x] Task 4: 新增治理台页面（路由策略 + 配额并发）
  - [x] SubTask 4.1: /gov/routing：列表 + upsert + disable（错误模型统一展示）
  - [x] SubTask 4.2: /gov/quotas：编辑 modelChatRpm 与 toolRef defaultMaxConcurrency
  - [x] SubTask 4.3: ConsoleShell governance nav 增加页面入口与 i18n keys

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API e2e：routing policy 生效与 fallback、RPM 配置生效、审计落库
  - [x] SubTask 5.2: Web e2e：治理模式下路由/配额页可访问

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 3, Task 4
