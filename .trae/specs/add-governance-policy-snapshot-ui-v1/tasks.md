# Tasks
- [x] Task 1: 增加治理侧导航与 i18n
  - [x] SubTask 1.1: ConsoleShell 增加“策略快照”导航项
  - [x] SubTask 1.2: locales 增加 gov.nav.policySnapshots 中英文

- [x] Task 2: 实现策略快照列表页
  - [x] SubTask 2.1: 新增 `/gov/policy-snapshots` 页面与 UI
  - [x] SubTask 2.2: 对接 `GET /governance/policy/snapshots`（filters + nextCursor）
  - [x] SubTask 2.3: 错误展示（errorCode/message/traceId）

- [x] Task 3: 实现策略快照详情页
  - [x] SubTask 3.1: 新增 `/gov/policy-snapshots/:snapshotId` 页面与 UI
  - [x] SubTask 3.2: 对接 `GET /governance/policy/snapshots/:snapshotId/explain`
  - [x] SubTask 3.3: 展示 matchedRules/fieldRules/rowFilters（可折叠 JSON）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: e2e：有权限可打开列表与详情页（至少 smoke）
  - [x] SubTask 4.2: e2e：无权限访问显示 AUTH_FORBIDDEN
  - [x] SubTask 4.3: 回归：不影响现有治理页面与导航

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
