# IMAP 附件落地 MediaObject（mediaRef）v1 Spec

## Why
《架构设计.md》强调通用协议连接器（IMAP/SMTP/Exchange）需要“附件处理与审计对齐”，并把 Media Contract 作为稳定契约，用于多模态素材的对象存储与治理挂点。当前 IMAP 入站仅保存附件摘要，缺少统一的可引用素材对象，导致后续知识证据链、审计追溯与内容治理难以复用同一套引用与权限模型。

## What Changes
- 在 IMAP 增量拉取中，将邮件正文与附件（在大小/类型约束内）落地为 MediaObject，并生成 `mediaRef`
- 将 `mediaRef` 列表写入 Channel Ingress Event 的 payload（仅引用 + 摘要，不写原文到审计）
- 引入最小护栏：单附件大小上限、总大小上限、contentType 白名单/黑名单（MVP 可先仅做大小限制）
- 与审计对齐：poll 入站审计 outputDigest 仅包含数量、hash、mediaRef 列表（不得包含正文/附件内容）

## Impact
- Affected specs:
  - 通用协议连接器：IMAP 增量拉取（MVP）
  - Media Contract：素材对象与处理流水线 MVP
  - Audit Contract：入站与下载审计字段约束
  - Knowledge Contract（预留）：证据引用可直接引用 mediaRef
- Affected code:
  - Worker：IMAP subscription poller（解析正文/附件并写入 MediaObject）
  - DB：复用 `media_objects`；复用 `channel_ingress_events`（payload 结构演进一般无需迁移）
  - API：复用 `/media/objects/:id/download` 提供附件下载

## ADDED Requirements
### Requirement: Ingress 事件写入 mediaRef（MVP）
系统 SHALL 在 `channel_ingress_events.payload` 中写入正文与附件的 `mediaRef` 引用集合。

payload 最小结构（示例）：
- `body?: { contentType: string, byteSize: number, sha256: string, mediaRef: string }`
- `attachments?: Array<{ fileName?: string, contentType?: string, byteSize: number, sha256: string, mediaRef: string }>`

#### Scenario: IMAP 拉取到带附件邮件
- **WHEN** poller 拉取到新邮件且包含附件
- **THEN** 为正文/附件创建对应 MediaObject
- **AND** 在 ingress event payload 写入 `mediaRef` 与摘要字段

### Requirement: 内容与审计隔离（MVP）
系统 SHALL 保证：
- 审计日志（audit_events.outputDigest/inputDigest）不得包含邮件正文全文或附件字节
- 仅允许记录摘要：数量、byteSize、sha256、mediaRef、邮件头摘要（from/to/subject/messageId 等）

#### Scenario: 审计可检索但不泄露内容
- **WHEN** 管理员按 traceId 检索审计事件
- **THEN** 可看到 mediaRef 与摘要
- **AND** 不出现正文/附件原始内容

### Requirement: 幂等与去重顺序（MVP）
系统 SHALL 保证 IMAP 拉取幂等（不因重复拉取同一 uid 重复创建 MediaObject）。

约束（MVP）：
- poller MUST 在创建 MediaObject 前先判断 ingress event 是否已存在（基于 eventId 唯一键）
- 如果 ingress event 已存在，则 MUST 跳过该邮件的正文/附件落地流程

#### Scenario: 重复拉取同一封邮件
- **GIVEN** 某封邮件已写入 ingress event（eventId 已存在）
- **WHEN** poller 再次拉取到同一 uid 的邮件
- **THEN** 不创建新的 MediaObject
- **AND** 不产生重复 ingress event

### Requirement: 大小护栏（MVP）
系统 SHALL 对落地 MediaObject 的内容大小施加护栏：
- 单附件大小上限（例如 5MB）
- 单封邮件总落地大小上限（例如 10MB）

超限行为（MVP）：
- 超限内容不得落地为 MediaObject
- 仍可在 ingress payload 中记录该附件的摘要字段（fileName/byteSize/sha256），但 `mediaRef` 为空或缺省

#### Scenario: 附件超限
- **WHEN** 单附件超过上限
- **THEN** ingress event 仍写入附件摘要
- **AND** 不生成该附件的 mediaRef

## MODIFIED Requirements
### Requirement: IMAP 内容摘要与证据引用（扩展）
原 “IMAP 入站事件仅保存摘要并预留 evidence 引用” 的能力 SHALL 进一步落地为：
- evidence 引用的首选形态为 `mediaRef`
- payload 同时携带摘要（sha256/byteSize）用于快速检索与治理挂点

## REMOVED Requirements
无

