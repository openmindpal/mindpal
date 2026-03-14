# Skill 运行时（进程隔离 + 最小权限 + 出站治理）MVP Spec

## Why
当前平台已具备 Tool Registry、Workflow/Queue、审计与受控工具执行，但工具实际执行仍缺少“运行时层”的统一隔离与出站治理，无法满足《架构-13-Skill运行时-隔离最小权限与出站治理.md》要求的默认拒绝、最小权限与可审计执行不变式。

## What Changes
- 新增 Runtime Contract（MVP）：ExecutionRequest/ExecutionResult 的最小字段集在 worker 内落地
- 新增执行限制（MVP）：timeoutMs、maxConcurrency（按 tenant + toolRef 维度）
- 新增出站治理（MVP）：默认拒绝出站；允许声明 allowedDomains 白名单并在执行前校验
- 新增能力包络（MVP 子集）：dataScope / egressScope / resourceLimits 的结构化快照写入 step/outputDigest
- 扩展审计：在 tool execute 的审计中附带 runtime 摘要（latencyMs、egressSummary、limitsSnapshot）

## Impact
- Affected specs:
  - Skill 运行时（隔离/最小权限/出站治理）
  - 工具注册表与受控执行（toolRef、依赖摘要/版本锁定后续扩展点）
  - 工作流与自动化（step 超时、并发、背压）
  - 审计域（执行指标与出站摘要）
- Affected code:
  - Worker：step processor 增加 runtime 执行封装与限制
  - API：Tool/Workflow 执行请求中增加 limits/networkPolicy（MVP 可选字段）
  - DB（可选）：若需要持久化 egressSummary/latencyMs，可扩展 steps 表或复用 outputDigest

## ADDED Requirements

### Requirement: Runtime Contract（MVP）
系统 SHALL 定义并实现运行时执行契约：
- ExecutionRequest：{ toolRef, subject, scope, input, policySnapshotRef, idempotencyKey, limits, networkPolicy }
- ExecutionResult：{ status, output, outputDigest, errorCategory, latencyMs, egressSummary }

#### Scenario: 执行回执包含运行时摘要
- **WHEN** worker 执行任意 toolRef step
- **THEN** steps.outputDigest 至少包含 latencyMs 与 egressSummary（MVP 可为空数组）

### Requirement: 默认拒绝出站（MVP）
系统 SHALL 默认拒绝工具执行时的任何出站网络访问；只有在 networkPolicy.allowedDomains 明确允许且通过审批/治理的情况下才允许出站。

#### Scenario: 未声明 allowedDomains
- **WHEN** tool 执行尝试发起 HTTP 请求且未声明 allowedDomains
- **THEN** 运行时拒绝并标记 errorCategory=policy_violation
- **AND** 审计记录被拒绝的域名摘要（不记录敏感 payload）

### Requirement: 执行限制（timeout + concurrency）
系统 SHALL 对每次执行强制 timeoutMs，并对同一 tenantId 下的同一 toolRef 强制 maxConcurrency。

#### Scenario: 超时终止
- **WHEN** step 执行超过 timeoutMs
- **THEN** 运行时终止并返回 errorCategory=timeout
- **AND** jobs/runs/steps 状态与重试策略按现有 workflow 机制处理

#### Scenario: 并发限制
- **WHEN** 同一 tenantId+toolRef 同时执行数超过 maxConcurrency
- **THEN** 新执行进入排队/拒绝（以实现为准，但必须可观测并可审计）

### Requirement: 能力包络快照（MVP 子集）
系统 SHALL 在执行前固化 capability envelope 的最小快照，并写入审计/回执，至少包含：
- dataScope（tenant/space/资源类型）
- egressScope（allowedDomains）
- resourceLimits（timeoutMs/maxConcurrency）

## MODIFIED Requirements

### Requirement: Tool 执行链路审计（扩展）
tool execute 审计事件 SHALL 附带 runtime 摘要字段（latencyMs、egressSummary、limitsSnapshot）。

## REMOVED Requirements
（无）

