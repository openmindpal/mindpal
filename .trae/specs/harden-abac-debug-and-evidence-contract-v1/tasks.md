# Tasks

- [x] Task 1: 定义策略调试与证据链强约束的契约与错误码
  - [x] SubTask 1.1: 定义 Policy Debug Evaluate 的 request/response 结构与错误码
  - [x] SubTask 1.2: 定义 EvidenceRef/AnswerEnvelope 与 EVIDENCE_REQUIRED 的全局约束点
  - [x] SubTask 1.3: 定义审计事件 schema（policy_cache.epoch_bumped、knowledge.answer、knowledge.answer.denied）

- [x] Task 2: 实现策略缓存 Epoch 与失效链路（API + changeset）
  - [x] SubTask 2.1: 增加 epoch 持久化与读写接口（按 tenant/space）
  - [x] SubTask 2.2: 在 RBAC/ABAC 相关写链路接入 epoch bump（最小覆盖）
  - [x] SubTask 2.3: 增加治理端手动失效 API，并写审计
  - [x] SubTask 2.4: 新增 changeset item kind：policy.cache.invalidate（preflight/rollbackPreview/release）

- [x] Task 3: 实现策略调试评估 API（可回溯到 Policy Snapshot）
  - [x] SubTask 3.1: 实现 `POST /governance/policy/debug/evaluate`（权限校验 + 输入校验 + 输出脱敏）
  - [x] SubTask 3.2: 评估结果落库为可解释快照（生成 policySnapshotId）
  - [x] SubTask 3.3: 为调试评估写审计（success/denied/invalid）

- [x] Task 4: Web 增加策略调试面板与缓存状态页面
  - [x] SubTask 4.1: 新增 `/gov/policy-debugger`（输入表单 + 结果渲染 + 链接到 explain）
  - [x] SubTask 4.2: 增加缓存 epoch 查看/手动失效入口（带 reason）
  - [x] SubTask 4.3: 增加导航与 i18n key（治理侧）

- [x] Task 5: 运行时接入证据链强约束（Orchestrator/Collab）
  - [x] SubTask 5.1: 在“使用检索的运行”上设置 evidencePolicy=required
  - [x] SubTask 5.2: 最终回答缺失证据时拒绝成功输出并产出稳定错误码
  - [x] SubTask 5.3: 满足/拒绝两种路径写审计，并可在治理侧关联 run/step

- [x] Task 6: 测试与回归验证
  - [x] SubTask 6.1: e2e：策略调试 evaluate 可用、可回溯 explain、越权拒绝
  - [x] SubTask 6.2: e2e：epoch bump 生效（RBAC 变更/手动失效/changeset 失效）
  - [x] SubTask 6.3: e2e：检索链路缺失证据会失败；带证据可成功且写审计

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 1
- Task 6 depends on Task 2, Task 3, Task 5
