# Tasks
- [x] Task 1: 扩展治理工具页面 UI（Network Policy）
  - [x] SubTask 1.1: 在 `/gov/tools` 增加 network policy 编辑 Card（scope/toolRef/allowedDomains）
  - [x] SubTask 1.2: 对接 GET/PUT `/governance/tools/:toolRef/network-policy`
  - [x] SubTask 1.3: 错误展示沿用 errorCode/message/traceId

- [x] Task 2: 增加 network policies 列表视图
  - [x] SubTask 2.1: 对接 `GET /governance/tools/network-policies`
  - [x] SubTask 2.2: 表格展示 toolRef/allowedDomainsCount/updatedAt

- [x] Task 3: i18n 与回归
  - [x] SubTask 3.1: 增加 zh-CN/en-US 文案 key
  - [x] SubTask 3.2: WEB_E2E smoke：/gov/tools 页面可加载（不破坏既有 tools 管理）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
