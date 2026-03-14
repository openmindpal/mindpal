# 离线同步（Sync：变更日志、冲突与可回放）MVP Spec

## Why
《架构-15》要求平台支持离线可编辑与多端一致性，并把同步过程纳入“统一链路（鉴权→校验→授权→审计）”。当前缺少增量 push/pull、OpId 幂等去重、基础冲突输出与可回放摘要，导致端侧无法安全可靠地做离线编辑与恢复。

## What Changes
- 新增 Sync 变更日志数据模型（MVP）：按 space 维护只追加 ops 流与水位（cursor）
- 新增增量同步 API（MVP）：`sync.pull` 与 `sync.push`
- 新增幂等去重（MVP）：对 `opId` 严格幂等；重复上报返回一致结果摘要
- 新增基础冲突输出（MVP）：对写入基于版本冲突/字段冲突输出 `conflicts[]`
- 新增可回放摘要（MVP）：对一次 push 的输入序列产出 deterministic digest，用于回放验证与回归
- 新增同步审计（MVP）：push/pull 写审计（输入摘要/输出摘要/拒绝原因）

## Impact
- Affected specs:
  - 数据平面（通用 CRUD 与记录版本）
  - 审计域（同步可追溯）
  - 认证与授权（push/pull 权限与字段裁剪一致）
  - 工作流与自动化（未来大批量同步可升级为异步作业）
- Affected code:
  - DB：新增 sync_ops / sync_cursors（或等价）
  - API：新增 /sync/pull 与 /sync/push（或等价）并接入审计
  - Tests/Docs：e2e 覆盖幂等去重、增量 pull、冲突输出

## ADDED Requirements

### Requirement: 操作（Op）与标识
系统 SHALL 支持端侧以“只追加操作日志”表达离线修改，并在服务端持久化。
- 必备字段（MVP）：
  - tenantId, spaceId
  - clientId, deviceId（可选但建议）
  - opId（全局唯一）
  - clock（可选，MVP 可先不参与排序）
  - baseVersion（端侧基于的投影版本）
  - schemaName, entityName, recordId
  - patch（JSONB）
  - contentDigest（用于审计与去重）

#### Scenario: 接收并记录一个 op
- **WHEN** 客户端 push 一个 op
- **THEN** 服务端持久化 op（append-only）
- **AND** 返回 accepted 列表与 serverWatermark

### Requirement: sync.pull（增量拉取）
系统 SHALL 支持按游标/水位增量拉取 ops。
- 接口：`sync.pull(spaceId, cursor, limit) -> { ops[], nextCursor, snapshotVersion }`
- 规则（MVP）：
  - cursor 为服务端游标（单调）
  - limit 有上限（例如 500）
  - 返回 ops 必须按服务端游标升序

#### Scenario: 拉取增量成功
- **WHEN** 客户端以 cursor 拉取
- **THEN** 返回该 cursor 之后的 ops 与 nextCursor

### Requirement: sync.push（增量推送）
系统 SHALL 支持批量推送 ops，并对 `opId` 做严格幂等。
- 接口：`sync.push(spaceId, ops[], clientWatermark) -> { accepted[], rejected[], serverWatermark, conflicts[] }`
- 幂等（MVP）：
  - 若 opId 已存在，视为已接收，返回与首次一致的结果摘要
  - 服务端必须避免重复应用副作用

#### Scenario: 重复 push 不重复生效
- **GIVEN** 同一 opId 已被接收
- **WHEN** 客户端再次 push 该 op
- **THEN** 返回 accepted 命中幂等
- **AND** 不产生新的审计副作用（或记录 dedupe 审计）

### Requirement: 基础冲突输出（MVP）
系统 SHALL 在检测到并发冲突时输出 `conflicts[]`，并保证冲突可解释。
- 触发条件（MVP）：
  - baseVersion 落后于服务端当前版本（recordVersion 不一致）
- 输出格式（MVP）：
  - `conflicts[]: { opId, targetRef, fieldPath?, reason, candidatesSummary?, resolutionHints? }`

#### Scenario: baseVersion 冲突返回 conflicts
- **WHEN** push 的 op.baseVersion 落后
- **THEN** 将该 op 置为 rejected 并返回 conflicts

### Requirement: 可回放摘要（Deterministic Digest）
系统 SHALL 为一次 push 的输入序列产出确定性摘要（digest），用于回放验证与回归。
- digest 输入（MVP）：按 opId 排序后的 {opId, contentDigest} 序列
- digest 输出（MVP）：sha256 hex

#### Scenario: 相同输入产生相同 digest
- **WHEN** 输入序列一致（忽略提交顺序）
- **THEN** digest 必须一致

### Requirement: 安全与审计对齐
系统 SHALL 确保 push/pull 都经过鉴权→校验→授权→审计链路。
- push/pull 必须写审计：
  - 输入摘要：opCount、cursor/spaceId、clientId/deviceId（如有）
  - 输出摘要：accepted/rejected/conflicts 数量、nextCursor/serverWatermark、digest

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

