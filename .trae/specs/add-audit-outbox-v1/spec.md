# 审计可靠写入 Outbox（写操作原子性）V1 Spec

## Why
《架构-02-BFF与统一API请求链路.md》要求避免“写成功但审计丢失”。当前实现将审计写入放在请求结束阶段：当审计写入失败时虽然返回 `AUDIT_WRITE_FAILED`，但业务写入可能已提交，仍然违反“可追溯/可治理”的不变式。需要引入事务外盒（Outbox）模式，把“业务写入 + 审计事件入 outbox”放进同一事务，确保原子性，并由异步投递器把 outbox 可靠写入 `audit_events`。

## What Changes
- 新增审计 outbox 表（append-only）：存储待投递的标准化审计事件（结构化摘要/脱敏后 digest）
- 新增 outbox 投递器（API 内后台循环或 worker job）：批量读取 outbox → 写入 `audit_events` → 标记 succeeded；失败进入 retry/死信
- 写操作链路改造（V1 范围）：对“必须强一致审计”的写请求，使用事务封装：
  - 业务写入与 outbox 插入同一 DB 事务提交
  - outbox 插入失败则整体回滚，业务不产生副作用
- 读操作维持 best-effort（不引入强一致要求），但 outbox 能力可复用（未来扩展）

## Impact
- Affected specs:
  - BFF/API 与统一请求链路（审计可靠写入边界）
  - 审计域（append-only 与可靠投递）
  - 工作流与自动化（写操作经常以 Job/Run/Step 形式落库）
- Affected code:
  - DB migrations：新增 audit outbox 表/索引
  - API：写接口执行封装（事务 + outbox insert）
  - API/Worker：outbox 投递器（重试/死信/观测指标）

## ADDED Requirements

### Requirement: AuditOutboxSchemaV1
系统 SHALL 提供审计 outbox 存储，至少包含：
- `outboxId`、`tenantId`、`spaceId`（可空）、`createdAt`
- `event`：标准化审计事件负载（结构化、已脱敏的 digest）
- `status`：`queued|processing|succeeded|failed`
- `attempt`、`lastError`（可空）、`nextAttemptAt`

#### Scenario: 插入 outbox
- **WHEN** 发生写操作且该请求的审计为 must-succeed
- **THEN** 系统在同一事务内插入 outbox 记录

### Requirement: AtomicWriteWithAuditOutboxV1
系统 SHALL 保证“写操作副作用”与“审计 outbox 入队”原子一致：

#### Scenario: outbox 插入失败导致整体失败
- **WHEN** 写操作事务内 outbox 插入失败（例如约束/连接/超时）
- **THEN** 事务回滚，业务写入不生效
- **AND** API 返回稳定错误码（例如 `AUDIT_OUTBOX_WRITE_FAILED`），不返回成功

#### Scenario: 写成功必有 outbox
- **WHEN** 写操作事务提交成功
- **THEN** 必须存在对应 outbox 记录可供后续投递到 `audit_events`

### Requirement: AuditOutboxDispatcherV1
系统 SHALL 提供 outbox 投递器，将 outbox 可靠写入 `audit_events`：
- 支持批量拉取与幂等写入（重复投递不产生重复审计事件）
- 支持指数退避重试与失败记录（deadletter 或 failed 状态）
- 投递器行为可观测（成功/失败计数、滞留数量）

#### Scenario: outbox 最终进入 audit_events
- **WHEN** outbox 记录处于 queued 状态
- **THEN** 投递器最终把对应事件写入 `audit_events` 并标记 succeeded

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

