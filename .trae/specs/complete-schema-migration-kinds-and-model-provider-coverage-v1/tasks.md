# Tasks

* [x] Task 1: Schema Migration kind 支持矩阵对齐与稳定失败语义

  * [x] SubTask 1.1: 定义支持的 migration kind 白名单并在 API/Worker 复用

  * [x] SubTask 1.2: Worker：不支持 kind 时落库 failed + 稳定 last\_error，避免重试风暴

  * [x] SubTask 1.3: 治理侧接口：创建迁移时拒绝不支持 kind（稳定错误）

* [x] Task 2: Model Gateway mock provider 实现补齐

  * [x] SubTask 2.1: /models/chat：实现 mock provider chat 路径并写 attempts/audit

  * [x] SubTask 2.2: 未实现 provider 的降级策略保持一致（仅在所有候选都不可用时返回稳定错误）

* [x] Task 3: 测试与回归

  * [x] SubTask 3.1: Worker 单测或集成测试：不支持 migration kind 的失败语义稳定且不触发重试

  * [x] SubTask 3.2: API e2e：mock provider 不再触发 PROVIDER\_NOT\_IMPLEMENTED；attempts 记录稳定

# Task Dependencies

* Task 3 depends on Task 1, Task 2

