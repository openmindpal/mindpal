# 审计域：不可篡改完整性（Hash Chain）V1 Spec

## Why
《架构-06》要求审计为 append-only 且不可篡改。当前系统已能在请求链路写入审计事件，但缺少“可验证的完整性”与“数据库层面的不可更新/删除约束”，难以满足合规与追责场景的基本要求。

## What Changes
- 审计事件不可变约束（V1）：
  - 在数据库层禁止 `audit_events` 的 UPDATE/DELETE（仅允许 INSERT）
- 审计完整性链（V1）：
  - 为每个 tenant 的审计流维护 hash chain（`prev_hash` + `event_hash`）
  - `event_hash` 基于规范化的事件摘要计算（避免原文敏感数据）
- 完整性校验 API（V1）：
  - 新增 `GET /audit/verify`：对给定 tenant/时间窗的链进行验证并返回摘要
- 审计对齐（V1）：
  - 任何完整性校验操作本身写入审计（resourceType=audit，action=verify）

## Impact
- Affected specs:
  - 审计域（append-only 与不可篡改）
  - 统一请求链路（审计写入路径）
  - 安全中枢（摘要脱敏策略仍生效）
- Affected code:
  - DB：audit_events 增加 hash chain 字段与触发器
  - API：auditRoutes 增加 verify 端点
  - AuditRepo：insertAuditEvent 增加 prev_hash/event_hash 写入逻辑（含并发序列化策略）

## ADDED Requirements

### Requirement: audit_events 仅允许追加（V1）
系统 SHALL 在数据库层强制 `audit_events` 为 append-only：
- UPDATE/DELETE MUST 被拒绝（返回错误）

#### Scenario: 禁止篡改
- **WHEN** 任何主体尝试更新或删除 `audit_events`
- **THEN** 数据库拒绝该操作

### Requirement: tenant 级 Hash Chain（V1）
系统 SHALL 为每个 tenant 的审计事件生成可验证的 hash chain：
- 每条事件写入：
  - `prev_hash`：该 tenant 上一条事件的 `event_hash`（首条为空）
  - `event_hash`：对“规范化事件摘要 + prev_hash”计算得到的 SHA-256
- 规范化事件摘要（V1）至少包含：
  - eventId、timestamp、subjectId、tenantId、spaceId
  - resourceType、action、result、errorCategory、toolRef、workflowRef
  - traceId、requestId、runId、stepId、idempotencyKey
  - inputDigest、outputDigest（脱敏后摘要）

约束（V1）：
- hash 计算 MUST 不依赖非确定性字段（如对象 key 遍历顺序）
- 并发写入 MUST 保证同一 tenant 的链顺序可验证（可用事务级锁）

#### Scenario: 生成 hash chain
- **WHEN** 系统写入一条审计事件（INSERT）
- **THEN** 该事件包含 prev_hash 与 event_hash
- **AND** event_hash 可用相同规则重复计算并一致

### Requirement: 完整性校验 API（V1）
系统 SHALL 提供完整性校验接口：
- `GET /audit/verify?tenantId=...&from=...&to=...&limit=...`

行为（V1）：
- 校验给定范围内事件链是否连续（prev_hash 串联正确）
- 返回：
  - ok（boolean）
  - checkedCount
  - firstEventId/lastEventId
  - lastEventHash
  - failures（最多 N 条摘要：eventId + reason）

#### Scenario: 校验通过
- **WHEN** 对未被篡改的事件链发起 verify
- **THEN** 返回 ok=true 且 failures 为空

#### Scenario: 校验失败可定位
- **WHEN** 链断裂或 hash 不匹配
- **THEN** 返回 ok=false 且 failures 包含可定位的 eventId 与原因

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

