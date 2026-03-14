# Workflow Step Input Envelope（Step 入参加密落库）V1 Spec

## Why
当前 `steps.input` 会把完整执行请求（含业务 payload、连接器参数等）以明文 JSONB 落库。即使审计已做摘要化，数据库层仍存在“敏感入参长期可读”的风险，不符合《架构设计.md》强调的默认安全与“内容治理/密钥托管”的基线要求。

## What Changes
- steps 入参加密落库（V1）：
  - `steps` 表新增加密字段：`input_enc_format`、`input_key_version`、`input_encrypted_payload`
  - 新创建的 step：将完整 `input` 以 envelope.v1（A256GCM + 分区密钥封装）加密写入 `input_encrypted_payload`
  - `steps.input` 仅保留最小可路由/可隔离的元信息（例如 spaceId、toolRef/kind、tenantId/subjectId 等），不得包含业务 payload 明文
- worker 执行兼容（V1）：
  - worker 读取 step 时：若存在 `input_encrypted_payload`，则解密得到完整 input 作为执行请求
  - 兼容旧数据：若无加密字段（历史 step），仍使用 `steps.input`（明文）执行
- 回放/检索兼容（V1）：
  - 现有依赖 `steps.input->>'spaceId'` 的隔离逻辑继续可用（因 `steps.input` 保留 spaceId）
  - `steps.input_digest` 继续用于回放匹配与绑定校验（不依赖明文 payload）

## Impact
- Affected specs:
  - 工作流与自动化（Run/Step 快照与执行）
  - 连接器与密钥托管（Keyring/Envelope）
  - 安全中枢（敏感信息最小留存）
- Affected code:
  - API：创建 step 的写入逻辑（加密与最小 input 元信息）
  - Worker：step processor 的 input 读取逻辑（解密与回退）
  - DB：steps 表迁移

## ADDED Requirements

### Requirement: StepInputEnvelopeV1（V1）
系统 SHALL 支持将 step 的完整执行输入以 envelope.v1 加密落库：
- 加密算法：A256GCM
- 密钥策略：使用 keyring 的分区密钥（scopeType=space, scopeId=spaceId），由 `masterKey` 解封
- 存储字段：`steps.input_enc_format='envelope.v1'`、`steps.input_key_version`、`steps.input_encrypted_payload`

#### Scenario: 创建 step 时不落明文 payload
- **WHEN** 创建任意 tool.execute 类 step
- **THEN** steps.input_encrypted_payload 存在且可解密得到完整 input
- **AND** steps.input 不包含业务 payload 明文（仅保留 spaceId/toolRef 等最小元信息）

### Requirement: Worker 兼容解密与回退（V1）
worker SHALL 按以下优先级取得执行输入：
1) 若 `input_enc_format='envelope.v1'` 且 `input_encrypted_payload` 存在：解密后作为执行 input
2) 否则：回退使用 `steps.input`（兼容历史数据）

#### Scenario: 历史 step 可继续执行
- **WHEN** step 记录无加密字段（历史数据）
- **THEN** worker 仍可使用明文 steps.input 执行（保持现有行为）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

