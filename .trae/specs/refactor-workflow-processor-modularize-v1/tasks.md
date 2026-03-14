# Tasks

* [x] Task 1: 设计并落地 workflow 模块拆分目录结构

  * [x] 明确 `processor.ts` 中现有职责分区与依赖方向（DB、审计、加密、policy、动态技能、内置工具）

  * [x] 规划 `apps/worker/src/workflow/` 下新增模块文件清单与对外导出策略（仅保留 `processStep` 对外）

* [x] Task 2: 抽离 policy/limits 与并发/超时等通用工具

  * [x] 迁移 limits/networkPolicy 归一化与 egress 判定逻辑到独立模块

  * [x] 如可行，复用同一实现到 `skillSandboxChild.ts`，避免重复实现漂移

* [x] Task 3: 拆分 dynamic skill runner

  * [x] 抽离 artifact skill 执行、child\_process 交互、egress 记录、depsDigest/runtimeBackend/degraded 处理

  * [x] 保持输出 schema 校验、输出大小限制、错误分类与回传语义不变

* [x] Task 4: 拆分内置工具分发与 job handlers

  * [x] 抽离 jobType 分支（entity.import/export、space.backup/restore 等）到 handlers

  * [x] 抽离内置工具（entity.*、memory.*、knowledge.\*、sleep、http.get 等）到 dispatcher

  * [x] 保持 writeLease、幂等记录、rowFilters/fieldRules 处理与 DB SQL 语义不变

* [x] Task 5: 拆分审计与加密相关逻辑

  * [x] 抽离审计写入、DLP 摘要挂载、output envelope 加密/解密辅助到模块

  * [x] 保持审计字段与敏感信息处理策略不变

* [x] Task 6: 全量回归验证与整理

  * [x] 运行 `npm run build -w @openslin/worker`

  * [x] 运行 `npm run test -w @openslin/worker`

  * [x] 必要时补充/更新最小单测以覆盖拆分边界（仅在现有覆盖不足时）

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 2

* Task 4 depends on Task 2

* Task 5 depends on Task 2

* Task 6 depends on Task 3, Task 4, Task 5

