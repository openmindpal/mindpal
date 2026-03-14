# 知识检索质量升级（Embedding/Rerank/证据链）与连接器摄取规模化 Spec

## Why
当前 Knowledge 检索使用 `ILIKE '%query%' + POSITION` 的 substring 召回/排序，质量与性能在规模增长时会同时遇到瓶颈；同时连接器摄取主要进入事件/媒体层，尚未形成可规模化的 Knowledge 文档化摄取链路，且跨模块权限一致性需要强化。

## What Changes
- 检索升级为 **多阶段管线**：
  - Stage A：BM25/关键词（或现有 substring）作为快速召回（可控候选池）
  - Stage B：Embedding 近邻召回（语义检索）
  - Stage C：Rerank（重排）在 TopK 上做精排
  - Stage D：证据链输出与落库（可回放）
- 知识索引升级为 **可扩展的向量索引**：
  - 为 chunk 增加 embedding 表示与生成作业
  - 支持“缺 embedding 仍可检索”的兼容路径
- 证据链升级：
  - evidence 结构包含 `rankReason/scoreDigest/snippetDigest` 等最小可解释字段
  - retrieval log 记录“每阶段策略摘要与数量”，不记录明文 query（保持现有安全原则）
- 连接器摄取规模化：
  - 引入 **Connector→Knowledge 摄取作业**：把 ingest events（或其摘要）转成 knowledge documents，并触发索引
  - 加入批处理、幂等与 backpressure（避免单轮订阅拉取把 DB 打爆）
- 权限一致性强化：
  - Knowledge 文档增加“可见性/归属”字段（space/subject），并在 search 时强制过滤
  - Connector 摄取写入的 Knowledge 文档可见性与 Connector scope 一致（space-scope→space 可见；subject-scope→subject 可见）

## Impact
- Affected specs:
  - `knowledge-layer-mvp`（检索与 retrieval log 扩展）
  - `add-knowledge-search-tool-v1`（tool 输出与 evidence digest 扩展）
  - `protocol-connector-*` / `subscription-runner-mvp`（摄取规模化与 backpressure）
- Affected code:
  - API：`apps/api/src/routes/knowledge.ts`、`apps/api/src/modules/knowledge/repo.ts`
  - Worker：`apps/worker/src/knowledge/processor.ts`、`apps/worker/src/knowledge/search.ts`、subscriptions processors
  - DB：`apps/api/migrations/011_knowledge.sql` 后续迁移（chunks embedding、visibility、ingest jobs 等）

## ADDED Requirements

### Requirement: 多阶段检索管线
系统 SHALL 支持以下检索管线，并保证可配置且可审计：
- **召回**：关键词/substring 召回 + embedding 召回，合并去重形成候选集
- **重排**：在候选集 TopK 上执行 rerank，得到最终排序
- **证据**：输出 evidence 列表，并写入 retrieval log（仅摘要与引用，不保存 query 明文）

#### Scenario: Embedding + rerank 的高质量命中
- **WHEN** 用户查询与原文无明显子串重叠但语义相关的内容
- **THEN** 召回阶段仍能找到相关 chunks（embedding）
- **AND** rerank 将更相关的 evidence 排在前列

#### Scenario: 兼容降级
- **WHEN** embedding 未生成或 embedding provider 不可用
- **THEN** 系统回退到关键词/substring 检索
- **AND** retrieval log 标记 `degraded=true` 与原因摘要

### Requirement: 向量索引与嵌入生成
系统 SHALL 为 `knowledge_chunks` 提供 embedding 存储与生成机制：
- 每个 chunk 可选地拥有 `embedding`（维度固定且与 embeddingModelRef 绑定）
- embedding 生成以异步 job 方式运行，支持重试与失败分类
- 支持 chunk 更新/文档新版本时重新生成 embedding（旧版本不覆盖）

#### Scenario: 新文档摄取后 embedding 自动补全
- **WHEN** 新 document 被摄取并完成切片
- **THEN** 系统创建 embedding job 并逐 chunk 生成 embedding
- **AND** 查询可立即用关键词召回，embedding 完成后自动提升质量

### Requirement: 证据链与可回放摘要
系统 SHALL 对每次检索生成可回放摘要（Evidence Chain）：
- evidence 条目 SHALL 包含：
  - `sourceRef`（documentId/version/chunkId）
  - `location`（chunkIndex/startOffset/endOffset）
  - `snippetDigest`（len + sha256_8；可选返回 snippet 文本）
  - `rankReason`（stage + 规则名 + 分数摘要，不含敏感文本）
- retrieval log SHALL 记录：
  - `rankPolicy`（如 `hybrid_embed_rerank_v1`）
  - `stageStats`（召回/合并/重排各阶段候选数量与耗时摘要）
  - `citedRefs`（被引用 chunks 列表）

#### Scenario: 审计/回放不泄露 query 与敏感原文
- **WHEN** 运行时记录检索轨迹
- **THEN** 审计与 retrieval log 不包含 query 明文与无必要全文
- **AND** evidence 仅包含必要摘要（允许有限 snippet，需遵循既有脱敏规则）

### Requirement: 连接器摄取 → Knowledge 规模化
系统 SHALL 支持把连接器摄取内容规模化转入 Knowledge：
- 支持从订阅 ingestion events 批量生成 Knowledge documents
- 支持幂等（同一源事件不会重复生成多份文档）
- 支持 backpressure：当 knowledge 索引积压时，摄取链路降速或暂停写入

#### Scenario: 大规模订阅不会拖垮 DB
- **WHEN** 订阅数量与事件吞吐上升
- **THEN** 摄取作业使用批处理与队列化，避免超长 SQL 与逐条写入
- **AND** 系统可观测积压（队列长度/失败率/延迟）

### Requirement: 权限一致性（Connector ↔ Knowledge）
系统 SHALL 保证连接器来源的 Knowledge 文档与检索权限一致：
- Knowledge documents SHALL 记录 `visibility`（`space`/`subject`）与 `ownerSubjectId`（可空）
- 搜索 SHALL 强制按 `tenantId/spaceId` + `visibility` 过滤：
  - `visibility=space`：空间内有 `knowledge.search` 权限的主体可检索
  - `visibility=subject`：仅 owner 可检索（仍需 `knowledge.search` 权限）
- Connector 摄取写入时：
  - space-scope connector → `visibility=space`
  - subject-scope connector → `visibility=subject` 且 owner 为 connector 创建者

#### Scenario: 防止越权召回
- **WHEN** 用户 A 与用户 B 在同一 space，但某 connector 内容为 subject 可见
- **THEN** 用户 B 的 knowledge.search 不得召回用户 A 的 subject-only 文档

## MODIFIED Requirements

### Requirement: /knowledge/search 输出结构（增强）
现有 `/knowledge/search` 与 `knowledge.search@1` 输出 SHALL 增强为：
- 保持兼容：现有 evidence 字段仍可用
- 新增：`rankPolicy`、`rankedEvidenceRefs`（含 rankReason/snippetDigest）
- `candidateCount` SHALL 表示“候选池总数（去重后）”，并新增 `returnedCount`

## REMOVED Requirements
无

