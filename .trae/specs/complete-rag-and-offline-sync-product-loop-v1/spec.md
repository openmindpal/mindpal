# Knowledge/RAG 与离线同步产品闭环 Spec

## Why
当前 worker 侧已具备 ingest/embedding/search 能力，但缺少“可治理、可运营、可验证”的产品闭环；离线同步服务端契约完备，但端侧加密与冲突修复体验缺失，导致多端离线不可用或难以运维。

## What Changes
- Knowledge/RAG：补齐权限检索治理面、证据链引用查看、检索质量评估与可视化运营（API + 控制台 UI）。
- 离线同步：补齐 Web 客户端侧离线加密存储、冲突可视化修复、变更日志/投影一致性调试工具链（最小产品闭环）。
- **BREAKING**：无（新增 API/页面；既有接口保持兼容）。

## Impact
- Affected specs:
  - upgrade-knowledge-retrieval-quality-v1（检索质量与日志）
  - add-knowledge-search-tool-v1（工具输出证据链）
  - offline-sync-mvp（服务端 sync.push/pull 与冲突输出）
- Affected code:
  - apps/worker/src/knowledge/**（摄取/embedding/search 已有能力的可观测对接）
  - apps/api/src/modules/knowledge/**、apps/api/src/routes/knowledge*.ts（新增读模型与治理接口）
  - apps/api/src/modules/sync/**、apps/api/src/routes/sync.ts（补齐客户端辅助读模型与运营接口）
  - apps/web/src/app/gov/**（新增 Knowledge 治理与运营页面）
  - apps/web/src/app/**（新增 Sync 客户端页面/组件；必要时扩展 /runs 展示证据链引用）
  - packages/**（Web 离线加密与 sync 客户端 SDK）

## ADDED Requirements

### Requirement: Knowledge 运营与治理面
系统 SHALL 提供 Knowledge 的可视化运营与治理入口，覆盖：文档/分块/摄取作业/embedding 作业/检索日志/质量评估。

#### Scenario: 检索日志可运营查看
- **WHEN** 管理员在控制台打开 Knowledge → Retrieval Logs
- **THEN** 系统显示按 tenant/space/subject/toolRef/time 过滤的检索日志列表
- **AND** 支持点开查看 stageStats、rankPolicy、rankedEvidenceRefs（证据链引用）与脱敏摘要

#### Scenario: 证据链引用可解析
- **WHEN** 用户在控制台或 run 详情页点击某条 evidenceRef
- **THEN** 系统返回该 evidenceRef 对应的文档元数据与最小必要片段（snippet）
- **AND** 若用户无权限访问对应文档，系统返回 403/NOT_ALLOWED 且不泄露任何片段内容

### Requirement: 检索质量评估（RAG Eval）
系统 SHALL 支持对 Knowledge 检索质量进行评估，并生成可视化报告，用于运营与回归。

#### Scenario: 运行一次检索评估并产出报告
- **WHEN** 管理员创建一个检索评估集（queries + 期望证据约束）并触发评估运行
- **THEN** 系统对每条 query 执行检索，记录命中情况、TopK 指标（如 hit@k / mrr@k）与失败原因分类
- **AND** 控制台可以按时间、评估集、模型/策略维度对比历史运行

### Requirement: 离线同步 Web 客户端闭环
系统 SHALL 提供 Web 客户端离线同步最小闭环：端侧加密存储、变更日志可视化、冲突修复并可重试同步。

#### Scenario: 端侧加密存储
- **WHEN** 用户启用离线模式并在无网络状态下产生变更
- **THEN** 变更日志（ops）与本地投影数据 SHALL 以加密形式落库（IndexedDB 或等价存储）
- **AND** 任意单条记录泄露时不应暴露明文业务字段（除允许的最小元数据，如时间戳/类型）

#### Scenario: 冲突可视化修复
- **WHEN** sync.push 返回 conflicts[]
- **THEN** 控制台/客户端 UI 展示冲突列表，并提供“保留本地 / 采用服务端 / 手动合并”三类修复操作
- **AND** 修复后系统生成确定性的修复 ops 并支持一键重试 push

#### Scenario: 投影一致性工具链
- **WHEN** 用户在 Sync Debug 页面运行一致性检查
- **THEN** 系统对比本地投影与服务端状态，输出差异摘要与可导出的调试信息（不含敏感明文）

## MODIFIED Requirements

### Requirement: offline-sync-mvp 的冲突输出可被 UI 消费
系统 SHALL 保持既有 sync.push/sync.pull 契约不变，并补齐 UI 友好字段（如 fieldPaths、humanHint、suggestedResolutions），确保冲突可视化修复无需依赖服务端私有实现细节。

### Requirement: Knowledge 检索权限在“解析证据链引用”链路一致生效
系统 SHALL 对 evidenceRef 解析、日志查看、文档预览等读入口统一执行与 knowledge.search 相同的权限过滤规则。

## REMOVED Requirements
无

