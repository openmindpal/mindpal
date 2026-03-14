# Tasks
- [x] Task 1: 设计并接入 closed-loop executor（默认单步工具执行）
  - [x] SubTask 1.1: 抽取 executor 选择与稳定 execution digest 输出
  - [x] SubTask 1.2: 复用/对齐 /orchestrator/execute 的治理校验与审计摘要

- [x] Task 2: 实现 closed-loop 的最小执行闭环与可追踪状态
  - [x] SubTask 2.1: 生成“动作候选”（基于 goal+evidence）并过滤不可执行项
  - [x] SubTask 2.2: 执行阶段写入 task_state phase=executed（queued/succeeded/failed/skipped）

- [x] Task 3: Media 处理器从占位升级为真实产物（extractText/thumbnail）
  - [x] SubTask 3.1: Worker 侧读取 MediaObject 内容（兼容现有存储形态）并实现 extractText
  - [x] SubTask 3.2: Worker 侧实现 thumbnail 生成并挂载到 derivatives（优先 artifactId）
  - [x] SubTask 3.3: 失败路径稳定化（错误码、error_digest/meta.errorDigest，不泄露敏感）

- [x] Task 4: Media 可插拔处理器挂点（transcode/transcript）
  - [x] SubTask 4.1: 定义处理器配置与缺省行为（未配置时稳定失败/跳过）
  - [x] SubTask 4.2: 为 transcode/transcript 预留产物与元数据契约（不引入破坏性变更）

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API e2e：/orchestrator/closed-loop 不再返回 no_executor_configured，且 execution 有稳定状态
  - [x] SubTask 5.2: Worker 单测或集成测试：extractText/thumbnail 产出真实衍生物或稳定失败摘要

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 4（共享处理器挂点与错误语义）
- Task 5 depends on Task 2, Task 3
