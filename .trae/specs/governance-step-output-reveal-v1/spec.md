# Governance Reveal Step Output（加密 Step 出参查看）V1 Spec

## Why
在 `workflow-step-output-envelope-v1` 中，`tool.execute` 的完整 step 出参将以 envelope.v1 加密落库，`steps.output` 仅保留安全展示字段。此举降低了明文敏感数据在数据库长期留存的风险，但也带来治理侧排障与合规核查时“无法在受控条件下查看完整出参”的缺口。

按照 `架构设计.md` 的不变式：敏感数据访问必须走统一请求链路、受 Policy 控制、并写审计。因此需要提供一个**治理侧受控解密查看**能力：仅限具备特定权限的主体、在明确 scope（tenant/space）下触发、并记录不可跳过的审计事件。

## What Changes
- 新增治理 API：解密查看某个 step 的完整 output
  - 仅支持 `steps.output_enc_format='envelope.v1'` 且 `output_encrypted_payload` 存在的 step
  - 使用 keyring 分区密钥（scopeType=space, scopeId=spaceId）+ `masterKey` 解封
  - 返回的 payload 作为“敏感内容”对待：不写日志、不进入普通审计的 outputDigest；仅返回给调用方
- 默认安全与最小暴露
  - 无权限 / 无匹配 scope / 非加密 step：不得返回解密内容
  - API 默认仍返回 `steps.output`（安全字段）；只有显式调用 reveal 接口才可获得完整明文
- 审计不可跳过
  - reveal 行为 SHALL 写入审计事件（resourceType=workflow, action=step.output.reveal），记录 stepId/runId/toolRef、scope、结果（success/denied/error）与 traceId

## Impact
- Affected specs:
  - BFF/API 与统一请求链路（治理端受控访问）
  - 认证与授权（新增治理动作权限）
  - 审计域（reveal 行为可追责）
  - 连接器与密钥托管（keyring/envelope 解密）
- Affected code:
  - API routes：新增治理端 endpoint（runs/governance 相关路由）
  - Policy/Permission：新增 action（例如 `workflow.step.output.reveal` 或 `governance.workflow.step.output.reveal`）
  - Audit：插入审计事件

## ADDED Requirements

### Requirement: RevealEncryptedStepOutputV1
系统 SHALL 提供治理端接口用于解密查看某个 step 的完整 output（若该 output 已使用 envelope.v1 加密存储）。

#### Scenario: 有权限时成功解密返回
- **WHEN** 具备 reveal 权限的主体请求解密查看 step output
- **AND** 目标 step 存在且属于请求主体可访问的 tenant/space
- **AND** step 存在 `output_encrypted_payload` 且 `output_enc_format='envelope.v1'`
- **THEN** 系统返回解密后的完整 output（JSON）
- **AND** 写入审计事件 `workflow:step.output.reveal`（result=success）

#### Scenario: 无权限或不满足条件时拒绝
- **WHEN** 主体缺少 reveal 权限，或 step 不属于可访问 scope
- **THEN** 系统返回拒绝（HTTP 403/404，按现有策略）
- **AND** 写入审计事件 `workflow:step.output.reveal`（result=denied）

#### Scenario: 目标 step 非加密 output 时不返回明文
- **WHEN** step 不存在 `output_encrypted_payload` 或 enc_format 非 envelope.v1
- **THEN** 系统不得返回任何“补充明文 output”
- **AND** 返回明确错误码（例如 `STEP_OUTPUT_NOT_ENCRYPTED`）

### Requirement: NoSensitiveLoggingV1
系统 SHALL 确保 reveal 接口的响应体不写入应用日志与常规审计字段（避免二次扩散）。

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

