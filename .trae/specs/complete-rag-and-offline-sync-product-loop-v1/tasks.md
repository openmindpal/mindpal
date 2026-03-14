# Tasks

- [x] Task 1: Knowledge 运营/治理读模型与 API
  - [x] SubTask 1.1: 增加 Retrieval Logs 列表/详情查询接口（含过滤与脱敏）
  - [x] SubTask 1.2: 增加 EvidenceRef 解析接口（权限校验 + 最小片段输出）
  - [x] SubTask 1.3: 增加 Ingest/Embedding Jobs 列表/详情接口（面向运营）

- [x] Task 2: Knowledge 控制台页面（运营闭环）
  - [x] SubTask 2.1: 新增 /gov/knowledge/retrieval-logs（列表 + 详情抽屉）
  - [x] SubTask 2.2: 新增 /gov/knowledge/jobs（ingest/embedding 的列表与状态筛选）
  - [x] SubTask 2.3: 在 run 详情/检索日志中支持 evidenceRef 跳转与查看

- [x] Task 3: 检索质量评估（RAG Eval）与可视化对比
  - [x] SubTask 3.1: 定义评估集与运行数据模型（queries + 期望证据约束 + 指标）
  - [x] SubTask 3.2: 实现评估运行管线（复用检索引擎、落库报告）
  - [x] SubTask 3.3: 新增 /gov/knowledge/quality（指标趋势/对比/失败分类）

- [x] Task 4: Web 离线同步客户端 SDK（加密 + 队列）
  - [x] SubTask 4.1: IndexedDB 持久化层（ops 队列 + 本地投影快照）
  - [x] SubTask 4.2: 端侧加密 envelope（WebCrypto AES-GCM；密钥生命周期与错误处理）
  - [x] SubTask 4.3: sync 引擎（push/pull、cursor/watermark、退避重试）

- [x] Task 5: 冲突修复 UI 与一致性调试工具
  - [x] SubTask 5.1: Sync Debug 页面（队列/水位/错误/一键 push/pull）
  - [x] SubTask 5.2: 冲突修复 UI（差异展示 + 三种修复策略 + 生成修复 ops）
  - [x] SubTask 5.3: 投影一致性检查（本地 vs 服务端差异摘要，可导出）

- [x] Task 6: 权限/审计/回归与文档
  - [x] SubTask 6.1: 权限回归：evidenceRef 解析与日志查看越权拒绝
  - [x] SubTask 6.2: e2e：RAG Eval 运行生成报告且可查询
  - [x] SubTask 6.3: e2e：离线冲突→修复→重试 push 成功
  - [x] SubTask 6.4: README：Knowledge 运营与离线同步客户端使用说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 5 depends on Task 4
- Task 6 depends on Task 1, Task 2, Task 3, Task 4, Task 5
