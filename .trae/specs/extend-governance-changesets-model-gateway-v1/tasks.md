# Tasks

* [x] Task 1: 扩展 ChangeSet item.kind 支持模型网关配置

  * [x] SubTask 1.1: changeSetRepo：新增 kind 类型与 validateItem 校验

  * [x] SubTask 1.2: governance routes：/changesets/:id/items 入参校验与 kind 白名单扩展

* [x] Task 2: 扩展 preflight 计划与回滚预览

  * [x] SubTask 2.1: preflight 生成 plan/currentStateDigest/rollbackPreview（模型路由、RPM、工具并发）

  * [x] SubTask 2.2: canary 模式限制：对不支持的 item 输出 warnings

* [x] Task 3: 扩展 release/rollback 执行器

  * [x] SubTask 3.1: release 应用变更并记录 rollback\_data（包含变更前快照摘要）

  * [x] SubTask 3.2: rollback 按 rollback\_data 恢复，保持幂等与审计摘要

  * [x] SubTask 3.3: canary 模式限制：release(mode=canary) 对不支持的 item 拒绝

* [x] Task 4: Web 治理台 ChangeSet 详情页支持新增 kind

  * [x] SubTask 4.1: /gov/changesets/:id 支持选择 model\_routing/model\_limits/tool\_limits kind

  * [x] SubTask 4.2: 表单字段与最小校验（purpose、modelRef、scope、rpm、toolRef、并发）

  * [x] SubTask 4.3: i18n keys（zh-CN/en-US）与错误模型统一展示

* [x] Task 5: 测试与回归

  * [x] SubTask 5.1: API e2e：changeset add→submit→approve→preflight→release→rollback 覆盖新 kind

  * [x] SubTask 5.2: Web e2e：治理模式下 changeset detail 可添加新 kind 并成功返回

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 1, Task 2

* Task 4 depends on Task 1

* Task 5 depends on Task 3, Task 4

