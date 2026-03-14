# 通知模板与多语言版本化（Notification Templates）V1 Spec

## Why
《架构设计.md》2.2 提到通知模板需要按语言版本化，且变更要可发布/灰度/回滚并进入审计。当前平台已有 Locale 默认与用户偏好、治理发布与审计，但缺少“通知模板”这一可运营对象，导致无法统一管理对外触达（邮件/短信/站内/IM）的文案与语言一致性，也无法对高风险通知进行变更治理。

## What Changes
- 新增 NotificationTemplate/NotificationTemplateVersion（V1）：
  - 模板 identity 稳定，版本包含多语言内容与渲染参数 schema
- 新增 Template 发布状态（V1）：
  - draft/released/disabled（与现有发布治理保持一致语义）
- 新增通知渲染与预览 API（V1）：
  - 预览渲染（按 locale 选择模板变体），用于 UI 校验与回归
- 新增 NotificationOutbox（V1 最小）：
  - 只落库“将要发送”的通知记录（不实现真实邮件/短信发送）
- 审计对齐（V1）：
  - 模板创建/发布/禁用、outbox 写入、预览渲染均写审计摘要（不记录敏感原文）

## Impact
- Affected specs:
  - 多语言（locale 优先级与 i18n 结构）
  - 治理控制面（模板发布/禁用）
  - 审计域（通知变更与触达意图可追溯）
  - 渠道接入（V2：将 outbox 投递到 IM/邮件/SMS）
- Affected code:
  - DB：新增 notification_templates/notification_template_versions/notification_outbox（或等价）
  - API：新增 /notifications/templates/* 与 /notifications/outbox/*

## ADDED Requirements

### Requirement: NotificationTemplate（V1）
系统 SHALL 支持通知模板的稳定 identity：
- NotificationTemplate：{ templateId, tenantId, scopeType(tenant/space), scopeId, key, channel(email/sms/im/inapp), status, createdAt, updatedAt }
- key 在同一 scope 内唯一

#### Scenario: 创建模板
- **WHEN** 管理者创建模板（key+channel）
- **THEN** 创建 template 记录并写审计（resourceType=notification_template, action=create）

### Requirement: NotificationTemplateVersion（V1）
系统 SHALL 支持模板版本，且版本内容支持多语言：
- NotificationTemplateVersion：{ templateId, version, status(draft/released), contentI18n, paramsSchema, createdAt, publishedAt? }
- contentI18n 最小结构（V1）：{ "zh-CN": { title, body }, "en-US": { title, body } }（允许只提供部分语言）

#### Scenario: 发布版本
- **WHEN** 管理者发布某模板版本
- **THEN** 该版本 status 变为 released，旧 released 仍保留（用于回放/回滚）
- **AND** 写审计（resourceType=notification_template, action=publish，包含 templateId/version 摘要）

### Requirement: Locale 选择与渲染预览（V1）
系统 SHALL 提供预览渲染能力：
- 按 locale 优先级选择内容：用户偏好 > space 默认 > tenant 默认 > 平台默认（zh-CN）
- 若目标语言缺失，则回退到 zh-CN；仍缺失则拒绝（稳定 errorCode）

#### Scenario: 预览渲染成功
- **WHEN** 调用预览接口并提供 params
- **THEN** 返回渲染后的 title/body 摘要
- **AND** 写审计（resourceType=notification_template, action=preview）

### Requirement: NotificationOutbox（V1）
系统 SHALL 支持写入待发送通知的 outbox：
- Outbox：{ outboxId, tenantId, spaceId?, channel, recipientRef, templateRef(templateId+version), locale, paramsDigest, status(queued/canceled/sent/failed), createdAt, updatedAt }
- V1 不实现真实发送，仅保证“写入+可查询+可取消+可审计”

#### Scenario: 写入 outbox
- **WHEN** 系统/工具写入一条通知 outbox
- **THEN** 记录被创建且 status=queued
- **AND** 写审计（resourceType=notification, action=enqueue）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

