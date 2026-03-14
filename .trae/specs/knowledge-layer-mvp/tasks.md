# Tasks
- [x] Task 1: 设计并落地知识层数据模型与迁移
  - [x] SubTask 1.1: 定义 documents/chunks/index_jobs/retrieval_logs 最小字段与索引
  - [x] SubTask 1.2: 定义 contentDigest/location/version 与 tenant/space 约束
  - [x] SubTask 1.3: 添加迁移并保证可重复执行

- [x] Task 2: 实现摄取 API（Document + IndexJob）并写审计
  - [x] SubTask 2.1: 实现 POST /knowledge/documents（鉴权/授权/审计）
  - [x] SubTask 2.2: 写入 Document 后创建 IndexJob（queued）并返回引用
  - [x] SubTask 2.3: 确保响应不返回全文原文（仅摘要/引用）

- [x] Task 3: 实现 worker 索引处理器（chunking + 关键词索引）
  - [x] SubTask 3.1: 处理 IndexJob：切片生成 Chunk（含 digest/location/snippet）
  - [x] SubTask 3.2: 更新 IndexJob 状态并写审计（index）
  - [x] SubTask 3.3: 失败可重试与错误分类（MVP：failed + lastError）

- [x] Task 4: 实现检索 API（结构化过滤 + 关键词召回）并产出证据链
  - [x] SubTask 4.1: 实现 POST /knowledge/search（tenant/space 强制过滤）
  - [x] SubTask 4.2: 生成 RetrievalLog（queryDigest/filtersDigest/candidateCount/citedRefs）
  - [x] SubTask 4.3: 返回 evidence[]（sourceRef/snippet/location/retrievalLogId）并写审计（search）

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e 覆盖：摄取→索引→检索→证据链字段存在
  - [x] SubTask 5.2: 覆盖：tenant/space 过滤生效（不可跨空间召回）
  - [x] SubTask 5.3: 更新 README：Knowledge API 入口与示例请求

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1, Task 3
- Task 5 depends on Task 2, Task 3, Task 4
