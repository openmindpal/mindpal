# Workflow Step Output Envelope（Step 出参加密落库）V1 Spec

## Why
当前 `steps.output` 会把工具执行的完整结果以明文 JSONB 落库。工具输出可能包含敏感数据（例如导出结果、用户内容片段、第三方系统返回体），即使审计侧已做摘要/脱敏，数据库层仍存在“敏感出参长期可读”的风险，不符合《架构设计.md》强调的默认安全、内容治理与密钥托管基线。

## What Changes
- steps 出参加密落库（V1）：
  - `steps` 表新增加密字段：`output_enc_format`、`output_key_version`、`output_encrypted_payload`
  - 当 step 成功写入 output 时：将“完整 output”以 envelope.v1（A256GCM + 分区密钥封装）加密写入 `output_encrypted_payload`
  - `steps.output` 仅保留“可安全展示”的最小结果（例如已脱敏/摘要化 outputDigest 或 UI 所需的安全字段），不得包含敏感明文
- worker 写入兼容（V1）：
  - 兼容旧数据：历史 step 无加密字段时，保持现有读取与展示逻辑不变
  - 仅对 `jobType=tool.execute` 的 step 启用（其它 jobType 维持现状，后续按需扩展）
- API/控制台展示兼容（V1）：
  - 对外 API 默认返回 `steps.output`（安全展示字段），不提供“直接解密返回完整 output”的新接口（避免扩大敏感面）
  - 回放/审批/编排等链路继续依赖 `output_digest` 与审计摘要，不依赖明文 output

## Impact
- Affected specs:
  - 工作流与自动化（Run/Step 结果存储与展示）
  - 安全中枢（输出脱敏/摘要化与最小留存）
  - 连接器与密钥托管（Keyring/Envelope）
- Affected code:
  - Worker：写 step 成功状态时的 output 持久化逻辑
  - DB：steps 表迁移
  - API：如存在 step output 回传/详情页展示，需确认仅使用安全字段

## ADDED Requirements

### Requirement: StepOutputEnvelopeV1（V1）
系统 SHALL 支持将 tool.execute step 的完整输出以 envelope.v1 加密落库：
- 加密算法：A256GCM
- 密钥策略：使用 keyring 的分区密钥（scopeType=space, scopeId=spaceId），由 `masterKey` 解封
- 存储字段：`steps.output_enc_format='envelope.v1'`、`steps.output_key_version`、`steps.output_encrypted_payload`

#### Scenario: step 成功时不落明文敏感 output
- **WHEN** tool.execute step 执行成功并产出 output
- **THEN** steps.output_encrypted_payload 存在且可解密得到完整 output
- **AND** steps.output 不包含敏感明文（仅保留安全展示字段或摘要）

### Requirement: Worker 兼容回退（V1）
worker SHALL 保持历史数据行为不变：
- 对于历史 step（无出参加密字段）：仍按现有 `steps.output` 写入与读取逻辑运行

#### Scenario: 历史 step 仍可正常展示与回放
- **WHEN** step 记录无 `output_encrypted_payload`
- **THEN** API/控制台仍可使用 `steps.output` 展示（保持现有行为）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

