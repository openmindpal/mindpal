# IM 渠道接入（Mock IM Adapter）MVP Spec

## Why
《架构设计.md》与《架构-17》提出“Webhook + 1 个 IM 渠道接入”为渠道入口 MVP。当前已具备 Webhook Ingress Gateway（验签/重放防护/去重/映射/回执），但缺少“对话型 IM 渠道”的消息模型与回执/撤销闭环。为后续接入真实 IM（Slack/飞书/企业微信等）铺路，本阶段先以 Mock IM Adapter 实现同构能力：入站规范化、身份映射、幂等、回执、撤销语义、以及与 orchestrator/workflow 的对齐。

## What Changes
- 新增 Mock IM Ingress API（MVP）：接收 message/command/callback 三类事件，转换为统一 Envelope 并触发 orchestrator（同步模式）
- 新增 IM Egress 回执 Outbox（MVP）：把回执写入 outbox，提供 poll API 供测试/模拟客户端拉取
- 新增撤销语义（MVP）：允许对尚未产生不可逆副作用的 run 进行 cancel，并回执 canceled
- 与现有 Channel 映射复用：复用 channel_accounts/channel_chat_bindings 作为 IM 身份映射

## Impact
- Affected specs:
  - 渠道接入（统一 Envelope、回执与撤销）
  - 工作流与自动化（长耗时/高风险后续可切 job/workflow）
  - 审计域（入站/回执/撤销均可追溯）
- Affected code:
  - DB：新增 channel_outbox_messages（或等价 outbox）
  - API：新增 /channels/im/mock/*（ingress/poll/ack/cancel）；复用 /governance/channels/* 映射写入
  - Tests/Docs：新增 e2e 覆盖 IM 入站、幂等、回执与撤销

## ADDED Requirements

### Requirement: Mock IM Ingress Envelope
系统 SHALL 支持 Mock IM 入站事件，并规范化为统一 Ingress Envelope。
- 入站事件类型（MVP）：
  - message：{ text, attachments? }
  - command：{ name, args? }
  - callback：{ actionId, value, messageRef }
- 每次入站 MUST 生成 requestId/traceId，并写审计（resourceType=channel, action=im.ingress）

#### Scenario: message 触发同步对话
- **WHEN** IM message 入站且身份映射成功
- **THEN** 触发一次 orchestrator turn（同步）
- **AND** 把结果回执写入 outbox

### Requirement: 入站幂等（IM）
系统 SHALL 对 IM 入站事件去重，避免渠道重试导致重复触发。
- 幂等键优先使用 IM 提供的 eventId/messageId
- 若缺失，则使用 deterministic key（provider+workspaceId+chatId+bodyDigest+timestampBucket）
- 去重命中 MUST 返回与首次一致的 correlation（至少 requestId/traceId 一致）

### Requirement: 回执 Outbox（拉取式）
系统 SHALL 把回执写入 channel_outbox_messages 并支持拉取。
- Outbox 字段（MVP）：
  - provider/workspaceId/chatId/toUserId?
  - correlation：requestId/traceId/runId?
  - status：received|processing|needs_confirmation|needs_approval|succeeded|failed|canceled
  - message：{ text, blocks?, attachments? }（仅可选摘要）
- Poll API SHALL 支持按 chatId 拉取未 ack 的回执并标记已投递

#### Scenario: 回执可追溯
- **WHEN** 入站触发并生成回执
- **THEN** 回执包含 requestId/traceId，可在审计中反查

### Requirement: 撤销（Cancel）语义（MVP）
系统 SHALL 支持对指定 correlation（runId 或 requestId）发起撤销，并产生 canceled 回执。
- 若 run 已完成或不可撤销，SHALL 返回稳定错误码并写审计

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

