# Orchestrator 知识检索建议（knowledge.search）V1 Spec

## Why
平台已具备知识层检索与 `knowledge.search@1` 工具执行能力，但 Orchestrator 目前只会对少量写入类意图给出 toolSuggestions，无法把“搜索/查资料/查知识库”这类读意图导入受控工具调用链路。需要按《架构设计.md》与《架构-08/10》让 Orchestrator 能生成 `knowledge.search` 的建议步骤，供控制台与 Agent Runtime 复用。

## What Changes
- Orchestrator `/orchestrator/turn` 增加对“检索/搜索/查找”等意图的识别
- 当 `knowledge.search` 在当前 space 有可用版本且已启用时，返回一条 toolSuggestion：
  - toolRef = 解析后的 `knowledge.search@<active>`（优先 active override/active version）
  - inputDraft = `{ query: <用户消息裁剪>, limit: <默认值> }`
- toolSuggestion 必须包含 toolContract 所需的展示字段（scope/resourceType/action/riskLevel/approvalRequired/idempotencyKey）
- 生成建议时仍需执行入参草稿的 schema 校验；不合法则不返回该建议

## Impact
- Affected specs:
  - AI 编排层（受控工具调用与回放）
  - 知识层（检索工具化入口）
- Affected code:
  - API：Orchestrator Turn 逻辑（suggestion 生成）
  - Tests：e2e 覆盖 Orchestrator 对 `knowledge.search` 的建议

## ADDED Requirements

### Requirement: 生成 knowledge.search 建议
系统 SHALL 在 `/orchestrator/turn` 中生成知识检索工具建议：

#### Scenario: 用户请求“搜索/查找”
- **WHEN** 用户消息包含“搜索/查找/检索/查资料/知识库”等意图关键词
- **AND** 当前 space 存在 released 的 `knowledge.search@*` 且已启用
- **THEN** Orchestrator 返回 toolSuggestions，至少包含 1 条 `knowledge.search@*`
- **AND** 该建议的 inputDraft 包含 query/limit 字段且通过 inputSchema 校验

#### Scenario: 工具不可用时不返回建议
- **WHEN** `knowledge.search` 未发布、未启用或缺少有效版本
- **THEN** Orchestrator 不返回该工具建议（toolSuggestions 中不包含它）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

