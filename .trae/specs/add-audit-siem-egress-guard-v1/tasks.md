# Tasks
- [x] Task 1: API test 增加 SIEM webhook 出站校验
  - [x] SubTask 1.1: 从 destination.secretId 解析 connectorInstanceId 并读取 egressPolicy
  - [x] SubTask 1.2: 校验 webhookUrl hostname；拒绝时返回 errorCode/message/traceId 并写审计

- [x] Task 2: Worker 投递增加 SIEM webhook 出站校验与审计字段
  - [x] SubTask 2.1: 读取 connector egressPolicy/defaultEgressPolicy 并校验 hostname
  - [x] SubTask 2.2: outputDigest 写入 egressPolicySnapshot/egressSummary
  - [x] SubTask 2.3: 拒绝时不发送请求，按 policy_violation 写审计

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: api e2e 覆盖允许/拒绝场景（test endpoint）
  - [x] SubTask 3.2: worker test 覆盖允许/拒绝场景（delivery）
  - [x] SubTask 3.3: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 3 depends on Task 1
- Task 3 depends on Task 2
