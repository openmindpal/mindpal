# Tasks
- [x] Task 1: 设计并落库 tool_network_policies
  - [x] SubTask 1.1: 新增 migration（表/索引/约束）
  - [x] SubTask 1.2: 新增 repo：get/upsert/list

- [x] Task 2: 治理 API 接入与权限
  - [x] SubTask 2.1: 新增 GET/PUT `/governance/tools/:toolRef/network-policy`
  - [x] SubTask 2.2: 新增 GET `/governance/tools/network-policies`
  - [x] SubTask 2.3: 接入 requirePermission + 审计摘要（count + sha256_8）

- [x] Task 3: 执行链路使用治理下发 networkPolicy
  - [x] SubTask 3.1: /tools/:toolRef/execute 忽略客户端 networkPolicy 并从治理配置注入
  - [x] SubTask 3.2: /orchestrator/execute 同上
  - [x] SubTask 3.3: outputDigest 增加 runtimePolicy.networkPolicyDigest

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: e2e：默认无配置时出站拒绝（policy_violation）
  - [x] SubTask 4.2: e2e：治理配置允许域名后放行
  - [x] SubTask 4.3: e2e：客户端传入 allowedDomains 不生效（仍按治理配置）
  - [x] SubTask 4.4: 回归：不影响现有 skill-runtime/egressSummary/DLP

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2
- Task 4 depends on Task 3
