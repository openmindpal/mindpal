# Tasks

* [x] Task 1: 定义并发布 knowledge.search\@1 的工具契约

  * [x] 确认 tool\_definitions 与 tool\_versions 的契约字段（scope/resourceType/action/Schema）

  * [x] 确认治理开关（tool\_rollouts enable/disable）对该 tool 生效

* [x] Task 2: 在 API 执行入口放行内置 knowledge.search

  * [x] tools.execute 放行无 artifactRef 的内置 tool 白名单包含 knowledge.search

  * [x] orchestrator.execute 放行无 artifactRef 的内置 tool 白名单包含 knowledge.search

  * [x] 确认权限校验为 resourceType=knowledge action=search

* [x] Task 3: 在 worker step 执行器实现 knowledge.search 的内置执行

  * [x] 复用/调用现有 knowledge 检索逻辑（SQL 或共享模块），强制 tenant/space 过滤

  * [x] 输出包含 retrievalLogId 与 evidence\[]，并确保 outputDigest 摘要可审计

  * [x] 不引入任何网络出站能力

* [x] Task 4: 补齐 e2e 测试与回归

  * [x] e2e：publish+enable knowledge.search\@1 后可通过 /tools/:toolRef/execute 执行并返回 evidence

  * [x] e2e：orchestrator.execute 可执行 knowledge.search\@1（至少 queued→worker 执行成功）

  * [x] 回归：审计/输出不包含敏感全文（仅摘要/引用）

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 1, Task 2

* Task 4 depends on Task 2, Task 3

