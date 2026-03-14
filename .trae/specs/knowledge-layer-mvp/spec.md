# 知识层（摄取/索引/检索/证据链）MVP Spec

## Why
平台已具备统一请求链路、审计、工作流/队列、受控工具调用与模型网关，但尚缺少“知识层”闭环：内容摄取→异步索引→受控检索→证据链可追溯。需要按《架构-10-知识层-摄取索引检索与证据链.md》落地 MVP，为 RAG 与可复盘回答提供可治理基础。

## What Changes
- 新增 Knowledge 数据对象（MVP 子集）：Document、Chunk、IndexJob、RetrievalLog
- 新增摄取 API（MVP）：写入 Document 并创建 IndexJob（异步索引）
- 新增检索 API（MVP）：结构化过滤 + 关键词召回（不含向量/重排）
- 新增证据链回执：返回 evidence[]（sourceRef/snippet/location/retrievalSummaryRef）
- 新增审计：摄取与检索均写审计（不记录敏感原文，记录摘要/引用列表）
- 对齐权限不变式：检索前 tenant/space 过滤 + 检索后再做行级过滤（MVP：tenant/space 级）

## Impact
- Affected specs:
  - 知识层（摄取/索引/检索/证据链）
  - 审计域（检索摘要与证据引用进入审计）
  - 工作流与自动化（索引任务异步化）
  - AI 编排层（search_knowledge/cite_evidence 的工具化入口预留）
- Affected code:
  - DB：新增 knowledge_* 表与索引
  - API：新增 /knowledge/* 路由，写审计
  - Worker：新增 index job 处理器（chunking + 关键词索引，MVP 可简单实现）

## ADDED Requirements

### Requirement: Document 摄取（MVP）
系统 SHALL 支持将文本内容摄取为 Document，并触发索引任务：
- `POST /knowledge/documents` 写入 Document（tenant/space 作用域）
- 自动创建 IndexJob（queued）
- 响应返回 documentId/version/indexJobId（不返回全文原文）

#### Scenario: 成功摄取并入队索引
- **WHEN** 管理者提交一段文本内容
- **THEN** 系统创建 Document 与 IndexJob
- **AND** 写审计（resourceType=knowledge, action=ingest），包含来源摘要与 documentRef

### Requirement: 异步索引（MVP）
系统 SHALL 以异步任务处理索引构建：
- Worker 处理 IndexJob：将 Document 切片为 Chunk
- Chunk MUST 写入 contentDigest 与 location（起止偏移或 chunkIndex）
- IndexJob 失败可重试（MVP：标记 failed + lastError）

#### Scenario: 索引成功
- **WHEN** IndexJob 被 worker 处理成功
- **THEN** 产生 Chunk 记录并将 IndexJob 标记 succeeded
- **AND** 写审计（resourceType=knowledge, action=index），包含 chunkCount 摘要

### Requirement: 检索（结构化过滤 + 关键词召回）
系统 SHALL 提供检索入口：
- `POST /knowledge/search`：输入 { query, filters?, limit? }
- 过滤阶段 MUST 强制 tenant/space 约束
- 召回阶段 MVP 使用关键词（例如 ILIKE/全文检索二选一，以实现为准）
- 返回 evidence[] 与 retrievalSummary（candidateCount/filtersDigest/citedRefs）

#### Scenario: 成功检索并返回证据链
- **WHEN** 用户提交 query 且空间内有命中文档
- **THEN** 返回 evidence[]（每条含 sourceRef/snippet/location）
- **AND** 写审计（resourceType=knowledge, action=search），记录查询摘要与引用列表（不记录不必要原文）

### Requirement: 证据链可追溯（MVP）
系统 SHALL 为每次检索生成 RetrievalLog（或等价摘要对象）：
- 包含 queryDigest、filtersDigest、candidateCount、citedChunkRefs（上限）
- 返回给客户端的 evidence 必须携带 retrievalLogId（或 retrievalSummaryRef）

### Requirement: 权限优先与双侧裁剪（MVP）
系统 SHALL 在检索前做 tenant/space 过滤，并在返回前再次校验：
- MVP：tenant/space 级过滤为强制要求
- 预留行级/字段级裁剪扩展点（后续对齐 Effective Schema）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

