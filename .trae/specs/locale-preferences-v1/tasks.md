# Tasks
- [x] Task 1: Locale 偏好存储与读取
  - [x] SubTask 1.1: 实现 userPreferencesRepo：getLocale/setLocale（基于 memory_user_preferences）
  - [x] SubTask 1.2: requestContext locale 解析接入 DB：user pref + space/tenant default_locale

- [x] Task 2: /me/preferences API
  - [x] SubTask 2.1: 新增 `GET /me/preferences`（返回 locale）
  - [x] SubTask 2.2: 新增 `PUT /me/preferences`（更新 locale，校验与 upsert）
  - [x] SubTask 2.3: 写审计（preferences.update，摘要）

- [x] Task 3: 回归测试与文档
  - [x] SubTask 3.1: e2e：PUT preferences 后 GET /me 回显 locale 生效
  - [x] SubTask 3.2: e2e：header x-user-locale 覆盖 user pref
  - [x] SubTask 3.3: README：补齐 /me/preferences 用法与优先级说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
