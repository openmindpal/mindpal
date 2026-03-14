# Tasks
- [x] Task 1: 对齐现状与目标差距并固化后端选择策略
  - [x] SubTask 1.1: 明确 process/container/remote 的选择优先级与生产默认策略
  - [x] SubTask 1.2: 明确降级策略（允许/禁止回退）与审计摘要口径

- [x] Task 2: 设计并落地 Remote Runner 注册表与执行协议
  - [x] SubTask 2.1: DB：新增 remote runner 表与最小字段（endpoint、enabled、capabilities、authRef）
  - [x] SubTask 2.2: API：新增治理接口（创建/启用/禁用/查询 runner；只读列表）
  - [x] SubTask 2.3: Worker：实现 remote 执行适配（超时、重试策略、错误分类、egressSummary 回填）

- [x] Task 3: 将 Trust Keys 治理化并接入执行前校验
  - [x] SubTask 3.1: DB：新增 trusted keys 表（tenant 隔离、keyId、publicKey、status、rotatedAt）
  - [x] SubTask 3.2: API：治理接口（新增/禁用/轮换 trusted key；只读查询）
  - [x] SubTask 3.3: Worker：执行前信任校验改为读取治理配置，并将决策写入审计摘要

- [x] Task 4: 扫描状态 gate 强制化（执行与治理）
  - [x] SubTask 4.1: 明确扫描状态机与摘要字段（pass/warn/block/unknown）
  - [x] SubTask 4.2: API：在 enable/release 等治理动作中加入不可绕过 gate，并提供只读阻断原因查询
  - [x] SubTask 4.3: Worker：执行前 gate 校验（失败返回稳定错误码/分类）

- [x] Task 5: 细粒度网络策略一致性与回归
  - [x] SubTask 5.1: 对齐 networkPolicy 的 schema 与默认拒绝策略（allowedDomains + rules）
  - [x] SubTask 5.2: 确保 process/container/remote 三后端对 egressSummary 口径一致
  - [x] SubTask 5.3: 增加覆盖测试（允许/拒绝、methods/pathPrefix、超限 maxEgressRequests）

- [x] Task 6: 测试与文档回归
  - [x] SubTask 6.1: 单测：remote 协议解析与错误分类稳定
  - [x] SubTask 6.2: e2e：TRUST_NOT_VERIFIED/SCAN_NOT_PASSED 在 enable/execute 上稳定阻断
  - [x] SubTask 6.3: e2e：生产默认容器 + 禁止回退策略生效（配置化）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 5 depends on Task 2
- Task 6 depends on Task 2, Task 3, Task 4, Task 5
