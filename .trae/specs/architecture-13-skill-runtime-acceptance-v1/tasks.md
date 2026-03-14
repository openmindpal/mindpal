# Tasks
- [x] Task 1: 出站治理可证明验收对齐
  - [x] SubTask 1.1: 复核 runtime.ts 的 allowlist/rules 判定与 egressSummary 摘要字段
  - [x] SubTask 1.2: 复核 sandbox 子进程对 fetch 的拦截一致性（skillSandboxChild.ts）
  - [x] SubTask 1.3: 补齐/更新 worker tests 覆盖 allow/deny 与摘要不泄露

- [x] Task 2: 资源限制可证明验收对齐
  - [x] SubTask 2.1: 复核 processStep.ts 对 timeout/concurrency/outputBytes 的强制点
  - [x] SubTask 2.2: 补齐/更新 worker tests 覆盖 timeout、并发限制、输出超限与审计摘要

- [x] Task 3: 供应链/版本锁定 gate 验收对齐
  - [x] SubTask 3.1: 复核 tools.ts 执行入口的 trust/scan/sbom/isolation/runner gate 不可绕过
  - [x] SubTask 3.2: 补齐/更新 API e2e 覆盖各类 gate 拒绝的稳定错误码与审计摘要

- [x] Task 4: Capability Envelope（统一能力包络）V1
  - [x] SubTask 4.1: 定义 capabilityEnvelope 结构（data/secret/egress/resource domains）
  - [x] SubTask 4.2: API 入队侧校验 envelope 结构与“不得扩大权限”的子集规则
  - [x] SubTask 4.3: worker 执行前复核 envelope 关键约束并写审计摘要
  - [x] SubTask 4.4: 回归用例覆盖：缺失/不合法 envelope 被拒绝（API 与 worker 两侧）

# Task Dependencies
- Task 2 depends on Task 1
- Task 4 depends on Task 1, Task 2
