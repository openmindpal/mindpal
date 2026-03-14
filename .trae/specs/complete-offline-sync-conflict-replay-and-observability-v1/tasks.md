# Tasks
- [x] Task 1: 扩展 Sync 冲突分类与合并运行数据模型
  - [x] SubTask 1.1: 新增 sync_merge_runs（transcript + digests）
  - [x] SubTask 1.2: 新增 sync_conflict_tickets（conflicts + status）
  - [x] SubTask 1.3: 定义 ConflictClass/Transcript/MergeSummary 的共享类型

- [x] Task 2: 扩展 sync.push 输出确定性合并摘要并落库
  - [x] SubTask 2.1: 生成 canonical transcript 与 mergeDigest
  - [x] SubTask 2.2: 冲突分类映射到 ConflictClass，输出 reasonCode/hints
  - [x] SubTask 2.3: 生成 repairTicketId（可修复冲突时）并写审计

- [x] Task 3: 增加冲突修复工单 API（list/get/resolve）
  - [x] SubTask 3.1: 查询 ticket 列表与详情（权限与空间隔离）
  - [x] SubTask 3.2: 提交 resolution 并生成新的 mergeRun
  - [x] SubTask 3.3: 解决/放弃工单状态机与审计

- [x] Task 4: 增加合并回放验证 API（get/verify）
  - [x] SubTask 4.1: GET mergeRun 返回 transcript 与 digests
  - [x] SubTask 4.2: POST verify 重新计算 digest 并返回差异摘要

- [x] Task 5: 增加治理侧可观测性摘要 API（SLO + Top Errors）
  - [x] SubTask 5.1: 定义 summary 输出结构与窗口参数
  - [x] SubTask 5.2: 从审计/指标生成聚合（低基数维度）
  - [x] SubTask 5.3: 增加 drill-down 到 audit 查询的关联字段

- [x] Task 6: 增加治理看板页面（Observability + Sync Conflicts）
  - [x] SubTask 6.1: 新增 /gov/observability：展示 SLO 与 topErrors
  - [x] SubTask 6.2: 新增 /gov/sync-conflicts：展示 tickets 并可查看详情
  - [x] SubTask 6.3: 增加导航与 i18n key

- [x] Task 7: e2e 覆盖与回归验证
  - [x] SubTask 7.1: sync.push：冲突分类输出与 mergeDigest 稳定
  - [x] SubTask 7.2: ticket：resolve 生成新 mergeRun 且状态流转正确
  - [x] SubTask 7.3: replay verify：digest 一致/不一致分支可测
  - [x] SubTask 7.4: observability summary：返回 SLO 汇总与 topErrors

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 1, Task 2
- Task 6 depends on Task 3, Task 5
- Task 7 depends on Task 2, Task 3, Task 4, Task 5
