# Tasks
- [x] Task 1: 扩展 run/step 的封存字段与 sealed digest 计算规则
  - [x] SubTask 1.1: DB migration：runs/steps 增加 sealed 视图字段（sealedAt/schemaVersion/digests/nondeterminismPolicy）
  - [x] SubTask 1.2: Worker：在 step 完成时生成 sealed digests（忽略非确定性字段）
  - [x] SubTask 1.3: API：读取 run/step 时返回 sealStatus（sealed/legacy）

- [x] Task 2: 回放与评测链路切换为“封存优先”
  - [x] SubTask 2.1: replay API 输出增加 sealed 摘要字段与 sealStatus
  - [x] SubTask 2.2: 从 replay 生成 EvalCase 时绑定 sealed digests 与 evidence digests
  - [x] SubTask 2.3: UI：回放/评测页面展示 sealStatus 与 sealed 摘要

- [x] Task 3: 证据链强约束终态化（执行/回放/评测一致）
  - [x] SubTask 3.1: Worker：检索发生时强制 evidenceRefs 必填，否则产出稳定失败语义与审计
  - [x] SubTask 3.2: API：EvalCase/AnswerEnvelope 输出只保留证据摘要字段，禁止明文落库
  - [x] SubTask 3.3: e2e：检索→缺证据拒绝；有证据放行且可回放/可评测

- [x] Task 4: SBOM（最小可用）与可复现供应链摘要落库
  - [x] SubTask 4.1: 发布链路生成 sbomDigest 与组件摘要（components + artifactFilesDigest + buildProvenanceDigest）
  - [x] SubTask 4.2: 治理侧查询/展示 SBOM 摘要与 digest；执行审计携带 sbomDigest
  - [x] SubTask 4.3: e2e：缺失 SBOM 的版本在 gate 开启时拒绝 enable/execute

- [x] Task 5: 系统级沙箱隔离级别契约与治理强制策略
  - [x] SubTask 5.1: 执行路径统一产出 isolation.level/enforced，并写入审计与回放
  - [x] SubTask 5.2: 治理侧新增/扩展 gate：要求特定范围必须 container/remote
  - [x] SubTask 5.3: e2e：隔离级别不满足拒绝；满足时可执行且可回放追溯

- [x] Task 6: 准入 gate 扩展与可解释 pipeline 输出
  - [x] SubTask 6.1: preflight/pipeline 增加 seal/evidence/sbom/isolation gate 摘要
  - [x] SubTask 6.2: release/enable/execute 在 fail 时返回稳定错误码并写审计
  - [x] SubTask 6.3: 回归：与既有 trust/scan/eval gates 不冲突

- [x] Task 7: 回归测试与文档补齐
  - [x] SubTask 7.1: 单测：sealed digest 去非确定性字段规则稳定
  - [x] SubTask 7.2: e2e：封存→回放→生成 EvalCase→准入 gate 闭环
  - [x] SubTask 7.3: e2e：SBOM gate + 隔离 gate 全链路

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 6 depends on Task 1, Task 3, Task 4, Task 5
- Task 7 depends on Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
