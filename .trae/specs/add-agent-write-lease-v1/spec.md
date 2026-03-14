# 写入单主（Write Lease）加固 v1 Spec

## Why
《架构设计.md》与《架构-18》要求“写入单主”：同一资源的写执行在同一时刻只能有一个执行者，避免并发副作用与不可追溯的竞态。当前工作流执行侧对“同一资源的并发写”缺少统一的租约机制，容易在高并发/重试/多智能体并行时产生重复或交错写入。

## What Changes
- 新增写租约数据模型：为 tenant/space 内的 resourceRef 维护短租约（TTL），记录 owner（runId/stepId/traceId）。
- 工作流执行侧写入加固：对写入类 tool 在执行前尝试获取租约；获取失败则返回可重试的“busy”结果（并写审计摘要），避免并发写副作用。
- 租约续期与释放：执行中按需续期；执行结束（成功/失败）释放；异常退出由 TTL 自然回收。
- 回归测试：覆盖并发写互斥、TTL 回收后可再次获取、审计摘要包含租约关键信息。

## Impact
- Affected specs:
  - 多智能体协作（写入单主规则）
  - 工作流与自动化（并发/重试与幂等）
  - 审计域（拒绝原因可追溯）
- Affected code:
  - DB：新增 workflow_write_leases（或等价表）
  - Worker：workflow processor 写入路径
  - Tests：worker 单测与/或 e2e 并发场景

## ADDED Requirements
### Requirement: 写租约（Write Lease）
系统 SHALL 在同一 tenantId/spaceId 内，对同一 resourceRef 的写执行强制互斥。

#### 定义（MVP）
- leaseKey：{ tenantId, spaceId, resourceRef }
- resourceRef：字符串，表达“写影响的资源”
  - MVP：对 `entity.create/entity.update/entity.delete` 取 `entity:${entityName}:${recordId}`（create 可用 `entity:${entityName}:${idempotencyKey}` 或由输入中的 recordId 决定）
  - 对 `memory.write` 取 `memory:${spaceId}`（或更细粒度的 memory namespace，如有）
- owner：{ runId, stepId, traceId }
- ttlMs：租约有效期，MVP 默认 60s；若 step 指定 timeoutMs，则 ttlMs SHOULD ≥ timeoutMs + 10s

#### Scenario: 获取租约并执行写入
- **WHEN** 执行一个写入类 tool
- **THEN** 系统尝试获取对应 leaseKey
- **AND** 获取成功后才允许进入真实执行
- **AND** 执行结束后释放租约

#### Scenario: 并发写入被阻断（busy）
- **GIVEN** 某 leaseKey 已被其他执行持有且未过期
- **WHEN** 另一个 step 尝试执行同一 leaseKey 的写入
- **THEN** 系统 SHALL 不执行写入
- **AND** 返回可重试错误（例如 `retryable:write_lease_busy`）与建议 backoffMs
- **AND** 写审计摘要（仅包含 leaseKey 摘要与 owner 摘要，不包含敏感输入原文）

#### Scenario: TTL 回收后可重新获取
- **GIVEN** 持有租约的执行异常退出且未释放
- **WHEN** 租约超过 ttlMs
- **THEN** 后续执行 SHALL 能重新获取租约并继续执行

### Requirement: 审计对齐（Write Lease）
系统 SHALL 在以下事件写入审计摘要：
- 获取租约成功/失败（至少失败要可追溯）
- busy 拒绝时记录：{ toolRef, leaseKeyDigest, ownerDigest, retryable=true }

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

