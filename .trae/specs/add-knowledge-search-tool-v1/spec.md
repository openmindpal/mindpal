# 知识检索 Tool（knowledge.search）V1 Spec

## Why
当前系统已有 Knowledge API（摄取/索引/检索/证据链）与受控工具执行链路，但知识检索尚未被纳入“工具化执行（Tool/Workflow/审批/审计）”主路径，Agent Runtime 也无法以统一方式调用检索能力并把证据链落到可回放的 Run/Step 轨迹中。需要按《架构设计.md》与《架构-10-知识层-摄取索引检索与证据链.md》将“检索”做成一等 Tool。

## What Changes
- 新增内置只读 Tool：`knowledge.search@1`（无 artifactRef，也不需要网络出站）
- `POST /tools/:toolRef/execute` 与 `POST /orchestrator/execute` 支持执行 `knowledge.search@1`
- Tool 执行输出包含 evidence[] 与 retrievalLogId，以便证据链可追溯且进入 step outputDigest
- 权限与治理：沿用既有 Tool 治理（enable/disable、RBAC）与审计链路

## Impact
- Affected specs:
  - 知识层（证据链在运行时轨迹中的可追溯）
  - AI 编排层 / Agent Runtime（可调用知识检索 Tool）
  - Skill/Tool 执行与治理（新增内置 Tool 类型）
- Affected code:
  - API：tools/orchestrator 路由（内置 Tool 白名单与权限校验）
  - Worker：workflow step 执行器新增对 `knowledge.search` 的执行分支
  - Tests：e2e 覆盖内置知识检索 Tool 的执行与输出

## ADDED Requirements

### Requirement: 内置 Tool 定义（knowledge.search@1）
系统 SHALL 支持一个内置 Tool：`knowledge.search@1`，其特性为：
- scope = `read`
- resourceType = `knowledge`
- action = `search`
- idempotencyRequired = `false`
- riskLevel = `low`
- approvalRequired = `false`
- 不依赖 artifactRef，不需要出站网络

#### Input（V1）
- `query`: string（required）
- `filters`: json（optional）
- `limit`: number（optional，默认 10，上限 50）

#### Output（V1）
- `retrievalLogId`: string（required）
- `evidence`: json（required；数组；每条包含 sourceRef/snippet/location 的最小集合）
- `retrievalSummary`: json（optional；candidateCount/filtersDigest/citedRefs 等摘要字段）

### Requirement: 受控执行（tools.execute）
系统 SHALL 允许通过 `POST /tools/:toolRef/execute` 执行 `knowledge.search@1`：

#### Scenario: 成功执行并返回证据链
- **WHEN** 用户在 space 上下文内执行 `knowledge.search@1`
- **THEN** 系统返回 `retrievalLogId` 与 `evidence[]`
- **AND** 执行结果被写入 Workflow step 的 output/outputDigest（含 retrievalLogId 摘要）
- **AND** 全链路写审计，且不得记录无必要的原文全文

### Requirement: 受控执行（orchestrator.execute）
系统 SHALL 允许通过 `POST /orchestrator/execute` 执行 `knowledge.search@1`，并复用同一套：
- 工具版本存在且 status=released
- 工具启用（tool rollout enabled）
- 入参 schema 校验
- 权限校验（resourceType=knowledge, action=search）

#### Scenario: Orchestrator 执行知识检索
- **WHEN** Orchestrator 选择执行 `knowledge.search@1`
- **THEN** 结果进入 Run/Step 并可在 /runs/:runId 查询到 step 摘要

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

