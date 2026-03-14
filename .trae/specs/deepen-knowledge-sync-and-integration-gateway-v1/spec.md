# 知识层/离线同步深化 + Integration Gateway 抽象演进 Spec

## Why
仓库已具备 ingest/search、sync API 与 web offline 客户端骨架，以及 OAuth 回调托管、Webhook 投递/DLQ、IMAP/SMTP/Exchange 等连接能力，但在“高质量证据链、复杂冲突处理、可运营指标与治理面板”与“统一 Integration Gateway 抽象 + 更广连接器生态”的产品化闭环上仍存在明显缺口。

## What Changes
- Knowledge（检索/证据链）：
  - 统一“可验证证据链”数据契约：检索日志、证据引用（evidenceRef）、证据片段、分数与归因、权限与脱敏信息的最小集合
  - 运营/治理面板：覆盖检索质量、证据链健康、摄取/索引作业、离线同步健康度等指标与告警入口
- Offline Sync（冲突/一致性）：
  - 扩展冲突分类与处理策略：支持更复杂的 JSON/列表/集合冲突呈现与半自动修复（基于 ops）
  - 提供端到端可观测性：冲突率、修复耗时、队列深度、重试/失败分布
- Integration Gateway（统一抽象）：
  - 引入统一的 Integration 定义（auth、ingress、egress、state、capabilities）与生命周期 API
  - 统一重试/DLQ/回放能力：把现有 webhook delivery、subscription runner、oauth callback 等纳入同一“集成网关”治理面
  - 以 1~2 个新增连接器作为抽象落地样例（优先选择低依赖协议或纯 Webhook/SaaS）

## Impact
- Affected specs:
  - Knowledge：ingest/search/evidenceRef/retrieval logs、治理与评测
  - Sync：push/pull、冲突与修复、端侧投影一致性
  - Governance：新增 Integrations 面板、指标与门槛（例如同步健康、连接器投递健康）
- Affected code:
  - API：`apps/api/src/modules/knowledge/*`、`apps/api/src/modules/sync/*`、连接器/订阅 runner 与治理路由
  - Web：`apps/web/src/lib/offline/*`、`apps/web/src/app/gov/*`（knowledge、sync、integrations）
  - Worker：subscription runner、webhook delivery、ingest/embedding job 执行与可观测性埋点
  - DB：新增或扩展读模型表/视图（指标、运行记录、冲突事件、integration state）

## ADDED Requirements

### Requirement: 高质量证据链数据契约（Evidence Chain Contract）
系统 SHALL 为一次检索输出一条可追溯、可审计、可最小泄露的证据链记录，至少包含：
- query 摘要（digest + locale + caller/toolRef 摘要）
- retrieval 配置快照引用（含 policy snapshotRef）
- evidenceRef 列表（每条包含：来源类型、sourceId 摘要、chunkId、score、rank、裁剪范围摘要）
- 脱敏/权限结果摘要（例如：命中敏感字段被裁剪、越权证据被剔除计数）
- 端到端时延与关键阶段耗时（ingest/search/rerank/format）

#### Scenario: 证据链可被最小化解析与展示
- **WHEN** 用户在治理面板查看一次检索日志
- **THEN** 系统返回的证据链 MUST 不包含越权原文
- **AND** 可通过 evidenceRef 解析接口查看“最小片段”（只读、可审计、可追溯）

### Requirement: 离线同步复杂冲突分类与修复（Advanced Conflict Resolution）
系统 SHALL 支持更复杂冲突的分类、呈现与修复：
- 冲突分类至少覆盖：字段冲突、列表/集合冲突、删除/复活冲突、并发创建冲突
- 修复动作 SHALL 以“ops 追加”的方式表达（不直接改写历史）
- 修复 UI SHALL 支持“半自动策略”（例如：按字段选择、三方合并、保留两份副本并标记）

#### Scenario: 用户可完成复杂冲突修复并重试 push
- **WHEN** 离线队列 push 返回冲突集合
- **THEN** 客户端展示冲突分类与差异摘要
- **AND** 用户完成修复后生成修复 ops
- **AND** 一键重试 push 后同步恢复健康状态

### Requirement: 可运营指标与治理面板（Ops Metrics + Governance Dashboard）
系统 SHALL 提供 Knowledge/Sync/Integrations 的可运营指标，支持：
- 指标趋势：检索命中率、证据链缺失率、p95 时延、摄取失败率、同步冲突率、DLQ 积压
- 维度筛选：tenant/space、toolRef、integrationId、connectorType、时间窗口
- 可操作入口：跳转到 run、retrieval log、DLQ 条目、冲突修复页面、integration 配置

## MODIFIED Requirements

### Requirement: Sync API（扩展）
sync API SHALL 扩展输出冲突诊断信息（摘要字段），并能关联到：
- 具体 objectKey 的最新 server 版本摘要
- 冲突类型与建议修复策略集合（不含敏感原文）

### Requirement: Webhook/Subscription/OAuth（统一纳入 Integration）
现有 OAuth 回调托管、Webhook 投递/DLQ、subscription runner SHALL 统一归入 Integration Gateway 的“运行记录/健康度/重试策略”视图中，并支持按 integrationId 追溯。

## REMOVED Requirements

### Requirement: 分散的连接器运行态与治理入口
**Reason**：当前连接器能力分散在不同模块与页面入口，难以形成统一抽象与运营闭环。
**Migration**：以 Integration Gateway 为统一入口逐步收敛，旧入口保留只读跳转与兼容期。
