# Tasks
- [x] Task 1: Device Runtime 默认拒绝与快照固化
  - [x] SubTask 1.1: 设备领取（claim）在无 DevicePolicy/空 allow-list 时默认拒绝
  - [x] SubTask 1.2: 管理侧创建执行（create）强制校验 allow-list 命中并拒绝不匹配
  - [x] SubTask 1.3: 创建执行时服务端生成并固化 policySnapshotRef（不信任入参）
  - [x] SubTask 1.4: 创建执行时 requireUserPresence 安全默认值（按 riskLevel）
  - [x] SubTask 1.5: API/worker e2e 回归：缺策略拒绝、allow-list 命中放行、快照字段落库可查

- [x] Task 2: 对齐并更新架构设计文档（Device Runtime）
  - [x] SubTask 2.1: 更新 `架构设计.md` 的 Device Runtime 阶段声明（已实现最小闭环 + 仍不继续扩展）
  - [x] SubTask 2.2: 在文档中明确默认拒绝要点与关键护栏（allow-list、确认闸门、审计/证据、快照）

- [x] Task 3: 移除/禁用 UI 模式切换并对齐架构 0.2
  - [x] SubTask 3.1: API：删除或彻底禁用 `/settings/ui-mode` 与相关存储/引用（如仍存在）
  - [x] SubTask 3.2: Web：移除任何 uiMode 切换入口与依赖逻辑，统一标准 ConsoleShell/AppShell
  - [x] SubTask 3.3: 更新 `架构设计.md` 的 0.2 表述，使其与代码一致（不做模式切换）
  - [x] SubTask 3.4: 回归测试：API tests、Web lint/e2e（与 uiMode 相关断言同步）

# Task Dependencies
- Task 2 depends on Task 1（文档需反映最终默认拒绝语义与字段）
- Task 3 can run in parallel with Task 1（如无共享迁移冲突），但文档更新统一在 Task 2/3 内完成
