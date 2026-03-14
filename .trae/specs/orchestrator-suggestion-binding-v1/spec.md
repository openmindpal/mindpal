# Orchestrator Suggestion Binding（建议持久化与确认执行绑定）V1 Spec

## Why
当前 `/orchestrator/turn` 只返回临时的 toolSuggestions，`/orchestrator/execute` 允许直接提交任意 `toolRef + input`。虽然仍受统一鉴权/授权/审计护栏保护，但缺少“建议→确认→执行”的服务端绑定对象，难以证明“本次执行来源于哪次建议”，也不利于后续回放评测与运营指标统计（人工确认率、拒绝率等）。

## What Changes
- Orchestrator Turn 持久化（V1）：
  - `POST /orchestrator/turn` 在返回 toolSuggestions 的同时，生成 `turnId` 并落库保存原始 message 与建议列表（含 inputDraft 摘要）
  - 为每条 suggestion 生成稳定 `suggestionId`（在 turn 内唯一即可）
- Confirmed Execute 绑定（V1）：
  - 扩展 `POST /orchestrator/execute`：支持通过 `{ turnId, suggestionId, input, idempotencyKey? }` 触发执行
  - 服务端校验：suggestion 必须存在，toolRef 必须与建议一致；input 必须通过该 toolRef 的 inputSchema
  - 保持兼容：原 `{ toolRef, input, ... }` 形式保留（用于内部/调试），但 UI 默认走绑定执行
- 审计补齐（V1）：
  - `orchestrator:turn` 的审计 outputDigest 增加 `turnId` 与 suggestion 摘要（不含敏感原文）
  - `orchestrator:execute` 的审计 outputDigest 增加 `turnId/suggestionId`（当使用绑定执行时）
- Console 演示页对齐（V1）：
  - `/orchestrator` 演示页执行时默认发送 `turnId + suggestionId`（不再直接用 toolRef 作为唯一来源）

## Impact
- Affected specs:
  - AI 编排层（运行上下文固化、确认执行绑定）
  - 审计域（turn/execute 关联）
  - 交互平面（Orchestrator 演示页）
- Affected code:
  - API：orchestrator turn/execute 路由与对应持久化 repo + migration
  - Web：演示页请求参数调整与显示 turnId/suggestionId
  - Tests：API e2e + Web e2e 冒烟

## ADDED Requirements

### Requirement: Turn 记录（V1）
系统 SHALL 在 `POST /orchestrator/turn` 成功时生成 turn 记录并返回：
- 返回体新增 `turnId: string`
- 返回体中每条 toolSuggestion 新增 `suggestionId: string`

#### Scenario: 生成建议并返回 turnId
- **WHEN** 用户调用 `/orchestrator/turn`
- **THEN** 系统生成 turnId 并落库保存：tenantId/spaceId/subjectId/message/toolSuggestions 摘要
- **AND** 返回包含 turnId 与带 suggestionId 的 toolSuggestions

### Requirement: 绑定执行（V1）
系统 SHALL 支持通过建议绑定对象触发执行：
- `POST /orchestrator/execute` 支持请求体：
  - `turnId: string`
  - `suggestionId: string`
  - `input: object`
  - `idempotencyKey?: string`

#### Scenario: 绑定执行成功
- **WHEN** 用户用 `{turnId, suggestionId, input}` 调用 `/orchestrator/execute`
- **THEN** 服务端校验 suggestion 存在且 toolRef 与建议一致
- **AND** 校验 input 通过 tool inputSchema
- **AND** 复用现有执行链路产生 queued 或 needs_approval
- **AND** 审计 outputDigest 记录 turnId/suggestionId（仅结构化摘要）

#### Scenario: suggestion 不存在或不匹配
- **WHEN** turnId 不存在或 suggestionId 不存在
- **THEN** 返回 404（稳定 errorCode）
- **WHEN** suggestion 存在但 toolRef 被篡改/不一致（服务端应拒绝）
- **THEN** 返回 409（稳定 errorCode=ORCH_SUGGESTION_MISMATCH）

### Requirement: 保持兼容（V1）
系统 SHALL 继续支持原始执行形式（用于内部/调试）：
- `POST /orchestrator/execute` 仍可接收 `{ toolRef, input, ... }`
- Console 演示页默认必须使用绑定执行形式

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

