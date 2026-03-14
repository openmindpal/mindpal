# Tasks
- [x] Task 1: 落库 Schema active 指针表
  - [x] 新增 migration：schema_active_versions（可选：schema_active_overrides）
  - [x] 增加必要的唯一键与索引（tenant_id + name）
- [x] Task 2: 扩展 schemaRepo 支持按 active 解析
  - [x] 新增 getActiveSchemaVersion/setActiveSchemaVersion/resolveEffectiveSchemaVersion
  - [x] 调整 `GET /schemas/:name/latest` 使用 active（含 space override 解析）
- [x] Task 3: 新增治理 API（set-active / rollback）
  - [x] 增加 `/governance/schemas/:name/set-active`
  - [x] 增加 `/governance/schemas/:name/rollback`
  - [x] 对齐权限校验与审计摘要写入
- [x] Task 4: 对齐数据面写入校验使用 active schema
  - [x] entities.create/update/import/backup/restore 等按 effective schema 解析
  - [x] 回归：不影响只读查询与 effective schema 生成
- [x] Task 5: 测试与回归
  - [x] e2e：set-active 后 `/schemas/:name/latest` 返回指定版本
  - [x] e2e：rollback 切回上一版本且立即生效
  - [x] e2e：写入校验随 active 版本切换而变化（至少覆盖 required 字段）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2
- Task 5 depends on Task 3, Task 4
