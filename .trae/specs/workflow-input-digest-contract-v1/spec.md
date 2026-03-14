# Workflow Input Digest Contract（可回放输入摘要标准化）V1 Spec

## Why
当前工作流 `runs.input_digest` 与 `steps.input_digest` 实际写入的是完整 input 对象（等同于 `steps.input`），其中包含 `traceId` 等非确定性字段以及可能包含敏感 payload（写工具入参）。这会导致：
- 回放匹配（`/replay/resolve` 以 inputDigest 精确等值匹配）不稳定且不可复用：同一业务输入因 traceId 不同而无法命中
- “摘要字段”语义被破坏：input_digest 并非脱敏摘要，无法满足架构-08 对运行上下文固化（digest 优先、可比较）的要求

## What Changes
- 标准化 InputDigest 语义（V1）：
  - 定义“可回放输入摘要”对象 `InputDigestV1`：以稳定哈希为主（sha256_8），辅以 keyCount/keys（可选）用于可解释性
  - 明确摘要计算范围：仅对“业务输入”做摘要，不包含 traceId/requestId 等非确定性元数据
- 工作流写入调整（V1）：
  - `runs.input_digest` 与 `steps.input_digest` 写入 `InputDigestV1`（不再写入完整 input）
  - `steps.input` 仍保留用于执行（worker 取用），但不作为回放匹配依据
- 回放匹配调整（V1）：
  - `POST /replay/resolve` 的 inputDigest 仍为对象，但其语义变为 `InputDigestV1`
  - DB 查询逻辑改为按 `steps.input_digest->>'sha256_8'` 匹配（而非 JSONB 全等），避免 keys 列表差异导致误判

## Impact
- Affected specs:
  - AI 编排层（运行上下文固化：toolRef + policySnapshot + inputDigest）
  - 工作流与自动化（runs/steps 的摘要字段语义）
  - 回放 API（resolve 匹配逻辑）
- Affected code:
  - API：创建 run/step 时的 inputDigest 计算与落库
  - API：/replay/resolve 查询条件调整
  - Tests：回放 resolve、审批 binding、orchestrator execute 等回归

## ADDED Requirements

### Requirement: InputDigestV1（V1）
系统 SHALL 定义并使用 InputDigestV1：
- `sha256_8: string`（稳定哈希的前 8 位，用于匹配与展示）
- `keyCount?: number`（可选）
- `keys?: string[]`（可选，建议按字典序截断到 N=50）

#### Scenario: 相同业务输入产生相同摘要
- **WHEN** 两次执行的业务输入相同（忽略 traceId/requestId 等非确定性字段）
- **THEN** 写入到 steps.input_digest 的 `sha256_8` 相同

### Requirement: runs/steps 的 input_digest 仅保存摘要（V1）
系统 SHALL 将 `runs.input_digest` 与 `steps.input_digest` 写为 InputDigestV1，而不是原始 input：
- **WHEN** 创建 run/step
- **THEN** input_digest 不包含原始业务 payload（仅摘要结构）

### Requirement: replay resolve 按摘要匹配（V1）
系统 SHALL 在 `/replay/resolve` 中按 `toolRef + policySnapshotRef + inputDigest.sha256_8` 匹配：
- **WHEN** 传入的 inputDigest.sha256_8 与历史 step 的 sha256_8 匹配
- **THEN** 返回 matches
- **WHEN** sha256_8 不匹配
- **THEN** 返回 404（NOT_FOUND）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

