# Tasks
- [x] Task 1: 定义 Model Gateway 契约与最小数据模型
  - [x] SubTask 1.1: 定义 /models/chat 请求/响应结构与 routingDecision 摘要字段
  - [x] SubTask 1.2: 定义 model_catalog seed 结构与 /models/catalog 输出字段
  - [x] SubTask 1.3: 定义 provider_bindings（scope + modelRef + connectorInstanceId + secretId）

- [x] Task 2: 落地迁移与 seed（Catalog + Bindings）
  - [x] SubTask 2.1: 添加 provider_bindings 迁移（含索引与 scope 约束）
  - [x] SubTask 2.2: 添加最小 model_catalog seed（可静态常量或表）
  - [x] SubTask 2.3: 确保迁移可重复执行

- [x] Task 3: 实现 Model Gateway API（catalog + bindings）
  - [x] SubTask 3.1: 实现 GET /models/catalog（鉴权/授权/审计）
  - [x] SubTask 3.2: 实现 POST/GET /models/bindings（校验 connector/secret 状态与 scope）
  - [x] SubTask 3.3: 绑定变更写审计（resourceType=model, action=bind）

- [x] Task 4: 实现 /models/chat（MVP 调用 + 治理）
  - [x] SubTask 4.1: 从 binding 解析 provider/model 与目标 host，强制 allowedDomains 校验
  - [x] SubTask 4.2: 实现 tenant 维度速率限制（Redis 窗口计数）
  - [x] SubTask 4.3: 实现提供方适配层（MVP：先支持 1 个 provider，其他返回 NOT_IMPLEMENTED）
  - [x] SubTask 4.4: 写审计（invoke）并输出脱敏 input/output digest 与 latencyMs

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: 覆盖：catalog 查询、binding 创建与校验失败路径
  - [x] SubTask 5.2: 覆盖：allowedDomains 拒绝、限流 429、审计落库
  - [x] SubTask 5.3: 更新 README：Model Gateway 入口与示例请求

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 3, Task 4
