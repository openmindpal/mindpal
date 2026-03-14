# Tasks
- [x] Task 1: 新增 /gov/artifact-policy 页面与数据对接
  - [x] SubTask 1.1: 新增 page.tsx/ui.tsx（scopeType 切换、表单、Load/Save）
  - [x] SubTask 1.2: 对接 GET/PUT /governance/artifact-policy
  - [x] SubTask 1.3: 错误展示沿用 errorCode/message/traceId

- [x] Task 2: 增加治理导航入口与 i18n
  - [x] SubTask 2.1: ConsoleShell 增加 Artifact Policy 导航项
  - [x] SubTask 2.2: 增加 zh-CN/en-US 文案 key（gov.nav.artifactPolicy 等）

- [x] Task 3: WEB_E2E 与回归
  - [x] SubTask 3.1: WEB_E2E smoke 增加 /gov/artifact-policy 页面加载校验
  - [x] SubTask 3.2: web lint + WEB_E2E 通过

# Task Dependencies
- Task 3 depends on Task 1
