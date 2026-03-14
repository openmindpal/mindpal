# 记忆层（Memory）MVP Spec

## Why
平台已有统一请求链路、审计、工作流执行与 AI 编排基础，但缺少“可见可控、可审计、可清除”的记忆层闭环：对话/任务的短期上下文无法持久化，长任务状态与产物摘要缺少统一存储接口，长期记忆写入缺少显式动作与治理边界。需要按《架构-11-记忆层-偏好长期记忆与任务状态.md》落地 MVP。

## What Changes
- 新增 Memory 数据对象（MVP 子集）：SessionContext、TaskState（最小化扩展 runs/steps）、LongTermMemory、UserPreference
- 新增记忆读写 API（MVP）：读为只读工具化入口，写为显式动作入口（不自动写入）
- 新增记忆治理 API（MVP）：list/delete/clear（可见可控与一键清除）
- 新增审计对齐：记忆 read/write/delete/clear 全部写审计（仅摘要，不存敏感原文）
- 新增内容治理对齐：写入长期记忆与返回记忆片段前强制 DLP 脱敏（复用 shared DLP）
- 新增生命周期字段（MVP）：retentionDays/expiresAt（过期后不再召回）
- 新增编排层工具化（MVP+）：memory.write@1 与 memory.read@1

## Impact
- Affected specs:
  - 记忆层（短期上下文/长期记忆/任务状态/生命周期治理 MVP）
  - AI 编排层（记忆读取工具化、执行与审计串联）
  - 安全中枢（DLP 脱敏对齐）
  - 审计域（记忆行为可追溯）
- Affected code:
  - DB：新增 memory_* 表；可选扩展 runs/steps 关联字段
  - API：新增 /memory/* 路由
  - Worker：新增 memory.read@1 / memory.write@1 的受控工具实现（或等价执行路径）

## ADDED Requirements

### Requirement: 长期记忆写入必须显式且可审计
系统 SHALL 默认不自动写入长期记忆；写入必须通过显式动作入口。
- 写入入口：`POST /memory/entries`
- 写入必须携带：
  - scope（tenant/space/user，MVP 至少支持 space/user）
  - type（preference/contact/project/template/other，MVP 可先支持 preference/other）
  - writePolicy（confirmed/approved/policyAllowed，MVP 先支持 confirmed）
  - sourceRef（对话/工具/导入/管理员，MVP 先支持 tool/conversation）
- 写入前 MUST 应用 DLP 脱敏（仅对存储内容与审计摘要，不改原业务数据）
- 写入后 MUST 写审计（resourceType=memory, action=write），记录摘要与确认方式
- 可选生命周期：支持 retentionDays，并在到期后不再返回于 list/search

#### Scenario: 用户确认写入一条偏好
- **WHEN** 用户调用写入接口并声明 writePolicy=confirmed
- **THEN** 系统保存一条 LongTermMemory（scope=user 或 space）
- **AND** 审计记录包含 type/scope/sourceRef 的摘要与 dlpSummary

### Requirement: 记忆读取为只读工具化入口
系统 SHALL 提供只读检索入口，用于编排层按授权召回记忆片段：
- 读取入口：`POST /memory/search`
- 输入：{ query, types?, scope?, limit? }
- 读取 MUST 强制 tenant/space 约束，并在返回前再次校验 scope（MVP：tenant/space）
- 返回内容 MUST 为裁剪后的片段与引用摘要（不返回不必要原文）
- 返回前 MUST 应用 DLP 脱敏（对 snippet 与摘要字段）
- 必须写审计（resourceType=memory, action=read），记录 queryDigest、命中条数、返回类型分布

#### Scenario: 编排层检索空间内记忆
- **WHEN** 以 space scope 检索 query
- **THEN** 返回命中片段与引用 id 列表
- **AND** 审计记录查询摘要与命中统计

### Requirement: 任务状态基础存储与可恢复查询
系统 SHALL 提供最小 TaskState 存储能力以支持长任务恢复与复盘：
- TaskState 与 Run/Step 必须可关联（runId/stepId）
- 提供写入/更新 TaskState 的入口（MVP 可作为内部 API 或工具执行产物）
- TaskState 仅存阶段/计划/产物摘要（不存高敏原文），并应用 DLP 脱敏
- TaskState 变更必须写审计（resourceType=run, action=state 或 resourceType=memory, action=task_state）

### Requirement: 可见可控与一键清除（MVP）
系统 SHALL 提供记忆治理能力：
- `GET /memory/entries`：按 scope/type 列表（分页）
- `DELETE /memory/entries/:id`：删除单条（软删或硬删以实现为准）
- `POST /memory/clear`：按 scope 清除（MVP 至少支持 user scope 一键清除）
- 删除/清除必须写审计（resourceType=memory, action=delete/clear），记录影响范围摘要

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）
