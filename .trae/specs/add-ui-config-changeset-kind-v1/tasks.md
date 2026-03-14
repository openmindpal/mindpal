# Tasks
- [x] Task 1: 扩展 changeset item kind 支持 UI 页面配置动作
  - [x] 增加 kind：ui.page.publish/ui.page.rollback
  - [x] 增加 payload 校验（pageName、scope 一致性）与风险分级规则
- [x] Task 2: 实现 UI 页面配置 preflight 摘要
  - [x] 输出 released 版本摘要、bindings 计数、toolRef 摘要哈希
  - [x] 确保不输出完整 page.ui/layout JSON
- [x] Task 3: 实现 UI 页面配置 release/apply 与 rollback
  - [x] release：发布 draft 或执行 rollback 到上一 released
  - [x] rollbackData：记录发布前状态并支持一键恢复
  - [x] 明确 canary 模式支持范围（V1 可不支持并给出 warnings/错误码）
- [x] Task 4: 收敛旧 UI 发布入口（V1）
  - [x] 如存在 /ui/* publish/rollback 入口：增加 deprecated 提示并指向 changeset
- [x] Task 5: 测试与回归
  - [x] e2e：ui.page.publish changeset 全链路（draft→preflight→submit→approve→release→rollback）
  - [x] e2e：ui.page.rollback changeset 全链路
  - [x] e2e：preflight 返回体不包含 page.ui/layout 原文

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 5 depends on Task 3
