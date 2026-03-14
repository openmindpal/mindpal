# 渠道接入（Channel Ingress Gateway）MVP Spec

## Why
《架构设计.md》与《架构-17》要求把 IM/Webhook 等外部入口统一收敛到平台请求链路，确保“入口无旁路、身份不可伪造、幂等优先、回执可追溯”。当前平台缺少可运营的统一入口层，需要先落地最小可用的 Webhook 入口闭环，并为后续 IM 渠道扩展预留一致的 Envelope 与映射模型。

## What Changes
- 新增 Webhook Ingress（MVP）：统一入站 Envelope、验签/重放防护、幂等去重、租户/空间归属与 Subject 映射
- 新增基础回执（MVP）：对入站事件返回 received/processing/succeeded/failed 之一的同步回执（后续可扩展异步回执）
- 新增渠道映射存储（MVP）：ChannelAccount / ChannelChatBinding / IngressEvent 持久化与审计对齐
- 与现有 Orchestrator/Workflow 对齐（MVP）：Webhook “message” 事件可触发一次 orchestrator turn（同步模式）

## Impact
- Affected specs:
  - BFF/API 统一请求链路（同一鉴权/审计/错误规范）
  - 认证与授权（渠道身份映射到 Subject、最小权限）
  - 审计域（入站/回执/拒绝原因可追溯）
  - 安全中枢（入站内容走 DLP/注入治理）
- Affected code:
  - DB：channel_accounts/channel_chat_bindings/channel_ingress_events（或等价）
  - API：新增 /channels/webhook/* 入口；新增 /governance/channels/*（配置映射）
  - Tests/Docs：新增 e2e 覆盖验签、幂等、映射与回执

## ADDED Requirements

### Requirement: 统一 Ingress Envelope（Webhook）
系统 SHALL 将 Webhook 入站事件规范化为统一 Envelope，并在审计中记录摘要。
- Envelope 最小字段（MVP）：
  - channel：{ type='webhook', provider, workspaceId? }
  - event：{ type='webhook', eventId, timestamp }
  - actor：{ channelUserId?, channelChatId?, mappedSubjectId? }
  - payload：{ path, method, headersDigest, bodyDigest, text? }
  - context：{ tenantId, spaceId, locale? }
  - security：{ signatureVerified, nonce, receivedAt }
  - idempotency：{ key }
  - trace：{ requestId, traceId }

#### Scenario: Webhook 入站被规范化并进入审计
- **WHEN** Webhook 请求到达入口
- **THEN** 生成 requestId/traceId 并写审计事件（action=webhook.received）
- **AND** 审计中仅存 headers/body digest（不存敏感原文）

### Requirement: 回调验签与重放防护（Webhook）
系统 SHALL 对 Webhook 请求执行签名校验与重放防护。
- 支持 provider 级签名策略（MVP：HMAC-SHA256）
- 必须校验：timestamp window + nonce 去重（窗口内不可重复）
- 若验签失败 MUST 返回 401/403 且写审计（action=webhook.denied, reason=signature_invalid）

#### Scenario: 验签失败被拒绝
- **WHEN** Webhook 携带错误签名
- **THEN** 返回 401/403
- **AND** 写审计，记录拒绝原因摘要

### Requirement: 入站幂等去重（Ingress Dedupe）
系统 SHALL 以 eventId 或 deterministic key 对入站事件去重，避免渠道重试导致重复触发副作用。
- 默认幂等键优先级：
  1) 解析得到的 eventId
  2) provider + workspaceId + path + method + bodyDigest + timestampBucket
- 去重命中时 MUST 返回与首次一致的回执（至少 correlation 一致）并写审计（action=webhook.deduped）

#### Scenario: 重复投递不重复执行
- **GIVEN** 同一事件被重复投递
- **WHEN** 再次请求进入入口
- **THEN** 不再次触发 orchestrator/workflow
- **AND** 返回幂等回执

### Requirement: Subject 映射与租户/空间归属（MVP）
系统 SHALL 将渠道身份映射为平台 Subject，并绑定 tenant/space 归属。
- 映射对象（MVP）：
  - ChannelAccount：{ provider, workspaceId, channelUserId, subjectId, tenantId, spaceId, status }
  - ChannelChatBinding：{ provider, channelChatId, tenantId, spaceId, defaultSubjectId? }
- 未找到映射时 MUST 拒绝或降级为 system subject（MVP 默认拒绝），并写审计（reason=mapping_missing）

#### Scenario: 缺少映射被拒绝
- **WHEN** Webhook 入站无法映射到 tenant/space/subject
- **THEN** 返回 403（稳定错误码）
- **AND** 写审计记录 mapping_missing

### Requirement: 基础回执（同步）
系统 SHALL 对 Webhook 入站返回标准化回执，包含可追溯 correlation。
- 回执（MVP）字段：
  - correlation：{ requestId, traceId, runId? }
  - status：received | processing | succeeded | failed | needs_confirmation | needs_approval
  - message：{ text? }
- 同步模式（MVP）：入口内可直接调用 orchestrator turn 并返回 succeeded/failed

#### Scenario: 同步回执成功
- **WHEN** Webhook message 触发一次 orchestrator turn 并成功
- **THEN** 返回 succeeded 与 correlation

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

