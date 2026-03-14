# 对话能力：接入模型网关并贯通多渠道对话 Spec

## Why
当前 Web `/chat` 与渠道接入（/gov/channels + 多 Provider 适配器）已经能触发 `/orchestrator/turn`，但 Orchestrator 仍以规则/关键词为主，不调用模型网关，且缺少跨轮次的会话上下文，导致“对话”无法形成《架构设计.md》要求的可用体验，也无法在已绑定的各渠道中实现自然对话闭环。

## What Changes
- Orchestrator `POST /orchestrator/turn` 生成 `replyText` 时接入 Model Gateway（复用 `/models/chat` 的统一链路：限流/配额、注入与 DLP、审计与 usage 归集）。
- 引入“会话上下文”（Session Context）机制：对 Web 对话与渠道对话统一使用 `conversationId` 作为会话主键，按窗口大小维护最近 N 轮消息，用于模型输入上下文。
- 渠道对话贯通：当渠道绑定/映射已配置（/gov/channels），各 Provider 的入站消息触发 Orchestrator 后，能够得到模型回复并通过既有 adapter send 回到对应渠道（Feishu/DingTalk/WeCom/Slack/Discord/QQ OneBot/iMessage bridge 等）。
- Chat Console 增强：Web `/chat` 在前端维护 `conversationId` 并在每次 turn 透传；提供“新会话/清空上下文”的显式入口（不自动写入长期记忆）。
- 错误与回执契约稳定：仍保持 `errorCode/message/traceId`、`toolSuggestions`、`uiDirective` 的结构化输出，确保 UI 与渠道回执可解释、可追溯。

## Impact
- Affected specs:
  - AI 编排层（《架构-08-AI编排层-受控工具调用与回放.md》）：对话回执、工具建议与审计不变式
  - 模型网关（《架构-09-模型网关-路由限流配额与回归.md》）：统一模型调用入口与治理
  - 渠道接入（《架构-17-渠道接入-IM与Webhook统一入口.md》）：多入口一致的对话触发与回执投递
  - 记忆层（《架构-11-记忆层-偏好长期记忆与任务状态.md》）：会话上下文的可控存取与生命周期
- Affected code:
  - API：`apps/api/src/routes/orchestrator.ts`、`apps/api/src/modules/orchestrator/*`
  - API：`apps/api/src/routes/models.ts` / `apps/api/src/modules/modelGateway/*`（复用，不新增旁路）
  - API：`apps/api/src/modules/channels/*`（入站触发与出站投递对齐）
  - Web：`apps/web/src/app/chat/*`（conversationId、重置入口、错误展示保持一致）

## ADDED Requirements
### Requirement: Orchestrator Turn 必须可调用模型生成回复
系统 SHALL 在 `POST /orchestrator/turn` 处理中，使用模型网关生成 assistant 的 `replyText`，并保持统一链路不变式（鉴权→校验→授权→执行→审计）。

#### Scenario: Web 对话生成回复（Success）
- **WHEN** 用户在 `/chat` 发送一条消息并携带 `conversationId`
- **THEN** Orchestrator 读取该 `conversationId` 的会话上下文（最近 N 轮）
- **AND** 通过模型网关生成回复文本并作为 `replyText` 返回
- **AND** Orchestrator 将本轮 user/assistant 消息写回会话上下文（窗口裁剪后持久化）
- **AND** 返回包含 `traceId` 以便端到端追踪

#### Scenario: 模型未配置或不可用（Error）
- **WHEN** 模型网关无可用绑定/路由策略导致无法完成调用
- **THEN** `POST /orchestrator/turn` 返回非 2xx
- **AND** 响应包含 `errorCode/message/traceId`
- **AND** Web/渠道侧按统一错误块展示（不泄露凭据）

### Requirement: 会话上下文必须可控、可裁剪、可清除
系统 SHALL 为对话提供 `conversationId` 并支持会话上下文窗口化存取：
- `conversationId` 对同一会话稳定
- 上下文仅保存最近 N 轮（配置项或常量，MVP 先固定）
- 提供显式“清空/新会话”能力，不自动写入长期记忆
- 会话读写行为 MUST 写审计（仅摘要，遵守 DLP/脱敏策略）

#### Scenario: 用户新开会话
- **WHEN** `/chat` 发起新会话（不提供 conversationId 或显式重置）
- **THEN** 系统生成新的 `conversationId`
- **AND** 新的 turn 只使用新会话上下文（空或初始提示）

### Requirement: 渠道绑定成功后可在对应渠道对话
系统 SHALL 在渠道配置与映射就绪后，实现“消息入站→turn→消息出站”的对话闭环：
- 入站消息通过 adapter 校验与幂等去重后触发 Orchestrator turn
- Orchestrator 使用 `conversationId` 与会话上下文生成 `replyText`
- adapter 将 `replyText` 投递回对应渠道（同一 chat/thread）
- 回执应携带 correlation（requestId/traceId 以及可用的 runId/approvalId 等）

#### Scenario: Feishu/Slack/其他渠道对话（Success）
- **WHEN** 渠道收到用户文本消息且该 chat 已绑定到 space 且用户已完成账号映射（或存在 defaultSubjectId）
- **THEN** 系统在该渠道回发一条 assistant 回复消息
- **AND** 重复投递/重试不会导致重复执行副作用（幂等仍生效）

## MODIFIED Requirements
### Requirement: Chat Console 透传 conversationId
系统 SHALL 在 Web `/chat` 中维护 `conversationId` 并在每次 `POST /orchestrator/turn` 请求中透传，以获得跨轮次上下文的一致回复；并提供显式重置入口。

## REMOVED Requirements
无

