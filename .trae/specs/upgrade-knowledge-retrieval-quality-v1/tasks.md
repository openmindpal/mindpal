# Tasks

- [x] Task 1: 设计并落地 embedding/重排/证据链数据模型迁移
  - [x] SubTask 1.1: knowledge_chunks 增加 embedding 元数据（modelRef/dim/ts）与可选向量存储
  - [x] SubTask 1.2: 新增 embedding_jobs 与 ingest_jobs（状态机/幂等键/重试字段）
  - [x] SubTask 1.3: retrieval_logs 扩展 stageStats 与 rankedEvidenceRefs（保持兼容）

- [x] Task 2: 实现 embedding 生成管线（worker）
  - [x] SubTask 2.1: embedding provider 适配（优先复用 Model Gateway 或内置 mock）
  - [x] SubTask 2.2: embedding job 批量化处理（分批提交/失败分类/可重试）
  - [x] SubTask 2.3: 文档新版本与 chunk 更新触发重算策略

- [x] Task 3: 实现 hybrid 检索与 rerank
  - [x] SubTask 3.1: 召回阶段：关键词/substring + embedding 召回合并去重
  - [x] SubTask 3.2: rerank 阶段：TopK 精排与分数摘要输出
  - [x] SubTask 3.3: 输出：rankPolicy/stageStats/rankReason/snippetDigest，写 retrieval log

- [x] Task 4: 连接器摄取规模化（Connector → Knowledge）
  - [x] SubTask 4.1: 从 ingestion events 构建 Knowledge documents 的映射与幂等键
  - [x] SubTask 4.2: 摄取作业批处理、队列化与 backpressure 指标
  - [x] SubTask 4.3: 摄取触发 index + embedding，并保证失败可重试

- [x] Task 5: 权限一致性强化
  - [x] SubTask 5.1: Knowledge documents 增加 visibility/ownerSubjectId 并在 search 强制过滤
  - [x] SubTask 5.2: Connector scope → visibility 的落地规则与审计摘要
  - [x] SubTask 5.3: e2e：subject-only 文档不可被同空间其他用户召回

- [x] Task 6: 回归、性能基线与文档
  - [x] SubTask 6.1: e2e：hybrid 检索（含降级）、rerank、证据链字段完整
  - [x] SubTask 6.2: 基准：大 chunks 表下避免全表扫描（至少提供 explain/索引策略说明）
  - [x] SubTask 6.3: README：检索管线配置项（embeddingModelRef/rerankModelRef）与运行约束

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 1, Task 2
- Task 5 depends on Task 1, Task 4
- Task 6 depends on Task 1, Task 2, Task 3, Task 4, Task 5
