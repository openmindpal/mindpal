# Orchestrator Turn Digests（对话回合脱敏摘要与最小留存）V1 Spec

## Why
当前 `orchestrator_turns` 记录会保存原始 message 与 toolSuggestions（含 inputDraft），存在把敏感内容长期落库的风险，也与“审计/留存默认只存结构化摘要、最小必要证据”的细分架构原则不一致（AI 编排层：运行上下文固化应以 digest 为主）。

## What Changes
- Turn 存储改为“摘要优先”（V1）：
  - `POST /orchestrator/turn` 仍返回 `turnId` 与 toolSuggestions（用于 UI 展示与用户确认）
  - 数据库层新增 `messageDigest` 与 `toolSuggestionsDigest` 字段（JSONB），用于持久化最小必要信息
  - 服务端停止写入原始 `message` 与完整 `tool_suggestions`（保留旧列但不再写入，后续由独立留存策略处理）
- Execute 绑定校验读取 digest（V1）：
  - 绑定执行 `{turnId, suggestionId, ...}` 在服务端通过 `toolSuggestionsDigest` 校验 suggestion 存在与 toolRef 一致
  - 不依赖 inputDraft 的持久化（避免敏感入参落库）
- 审计对齐（V1）：
  - `orchestrator:turn` 的审计 outputDigest 继续只保留摘要（turnId、suggestions 元信息），不得包含原始 message 或完整 inputDraft

## Impact
- Affected specs:
  - AI 编排层（运行上下文固化的最小留存）
  - 审计域（摘要 vs 原文边界）
- Affected code:
  - DB migration：`orchestrator_turns` 新增 digest 列
  - API：orchestrator turn/execute 读写 turn 记录的逻辑
  - Tests：API e2e + Web e2e（保持原有行为，验证绑定执行不依赖原文存储）

## ADDED Requirements

### Requirement: Turn 最小留存（V1）
系统 SHALL 在 turn 记录中持久化脱敏摘要而非原文：
- turn 记录包含 `messageDigest`（例如：长度、sha256_8、语言/键摘要等）
- turn 记录包含 `toolSuggestionsDigest`（每条包含 suggestionId、toolRef、riskLevel、approvalRequired、idempotencyKey?、inputDigest?）
- turn 记录不得持久化原始 `inputDraft`

#### Scenario: 生成建议并持久化 digest
- **WHEN** 用户调用 `/orchestrator/turn`
- **THEN** 返回仍包含 toolSuggestions（可用于 UI 展示）
- **AND** 数据库中 turn 记录仅保存 messageDigest/toolSuggestionsDigest（不保存原始 message、inputDraft）

### Requirement: 绑定执行使用 digest 校验（V1）
系统 SHALL 在 `{turnId, suggestionId}` 绑定执行路径中：
- 通过 `toolSuggestionsDigest` 校验 suggestion 存在且 toolRef 与绑定一致
- **WHEN** digest 中不存在 suggestionId
- **THEN** 返回 404
- **WHEN** digest 中 suggestion 缺失 toolRef 或 toolRef 非法
- **THEN** 返回 409（ORCH_SUGGESTION_MISMATCH）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

