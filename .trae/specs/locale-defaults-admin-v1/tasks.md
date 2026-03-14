# Tasks
- [x] Task 1: 默认语言读写 Repo
  - [x] SubTask 1.1: 实现 tenantLocaleRepo：getDefaultLocale/setDefaultLocale
  - [x] SubTask 1.2: 实现 spaceLocaleRepo：getDefaultLocale/setDefaultLocale（校验 tenant_id）

- [x] Task 2: Settings API（locale defaults）
  - [x] SubTask 2.1: 新增 `GET /settings/locale-defaults`
  - [x] SubTask 2.2: 新增 `PUT /settings/tenant-locale`
  - [x] SubTask 2.3: 新增 `PUT /settings/space-locale`

- [x] Task 3: 鉴权、审计与回归
  - [x] SubTask 3.1: 使用 `governance:locale.read`（读取）与 `governance:locale.update`（更新）
  - [x] SubTask 3.2: update 写审计（仅摘要）
  - [x] SubTask 3.3: e2e：更新 tenant/space default_locale 后，GET /settings/locale-defaults 生效
  - [x] SubTask 3.4: README：补齐 settings 接口示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
