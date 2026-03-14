# Tasks
- [x] Task 1: 设计并落地 Connector/Secret 数据模型与迁移
  - [x] SubTask 1.1: 定义 connector_types/connector_instances/secret_records 最小字段集合
  - [x] SubTask 1.2: 定义状态机（enabled/disabled, active/revoked）与索引
  - [x] SubTask 1.3: 添加迁移并保证可重复执行

- [x] Task 2: 实现 Connector API（类型/实例）
  - [x] SubTask 2.1: 实现 ConnectorType 列表/详情（内置 seed，MVP 固定集合）
  - [x] SubTask 2.2: 实现 ConnectorInstance 创建/禁用/查询（按 tenant/space）
  - [x] SubTask 2.3: 为连接器变更写审计（create/enable/disable）

- [x] Task 3: 实现 Secrets API（创建/撤销/查询）
  - [x] SubTask 3.1: 实现 SecretRecord 创建（加密存储，不返回明文）
  - [x] SubTask 3.2: 实现 SecretRecord 撤销（revoked）与查询（不含 payload）
  - [x] SubTask 3.3: 确保任何路径都无法返回明文（稳定 errorCode + 审计）

- [x] Task 4: 对齐运行时出站治理（MVP 贯穿）
  - [x] SubTask 4.1: 定义 connector egressPolicy.allowedDomains 与 runtime networkPolicy.allowedDomains 的映射策略
  - [x] SubTask 4.2: 为后续 connector 调用路径预留执行入口（MVP 可仅校验与回执）
  - [x] SubTask 4.3: 写审计字段：connectorRef/targetHost/purpose/resultSummary（MVP 摘要）

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: 覆盖：创建连接器实例、写入 secret、撤销 secret
  - [x] SubTask 5.2: 覆盖：禁止读取明文（所有接口）
  - [x] SubTask 5.3: 更新 README：如何创建 connector/secret 与 allowedDomains

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 2, Task 3
