# 本机执行端受控执行（Device Runtime Execution）V1 Spec

## Why
《架构设计.md》3.1.2 明确本机执行端的目标是把设备能力收敛为受控 Tool/Skill 执行：仍遵守统一链路（鉴权→校验→授权→执行→审计），并将关键证据回传以支撑回放与追责。当前系统已具备 Device Enrollment（注册/配对/心跳/撤销）与 Tool Registry/Workflow/Audit，但缺少“平台下发设备侧执行请求、设备侧领取执行、回传结果与证据”的最小闭环，无法安全接入端侧能力。

## What Changes
- 新增 DeviceExecution 一等对象（V1）：
  - 表达一次设备侧受控执行请求，记录 toolRef、policySnapshotRef、幂等与证据引用
- 新增设备侧领取与回传 API（V1）：
  - 设备 poll/claim 待执行请求
  - 设备提交执行结果（仅摘要 + evidenceRefs）
- 审计对齐（V1）：
  - 创建请求、设备领取、结果回传均写审计（不包含敏感明文）
- 约束（V1）：
  - 设备侧只能执行已发布 toolRef（带版本/依赖摘要）
  - 设备侧执行仍受 DevicePolicy（allowedTools、networkPolicy、limits）与 server-side policyDecision 约束

## Impact
- Affected specs:
  - Device Runtime（ExecutionRequest/Result 最小闭环）
  - AI 编排层（Run/Step 可关联 deviceExecutionId）
  - 审计域（证据引用、可追溯性）
  - Skill Runtime（V2：统一的执行沙箱抽象）
- Affected code:
  - DB：新增 device_executions（或等价）迁移与索引
  - API：新增 /device-executions（管理侧）与 /device-agent/executions（设备侧）

## ADDED Requirements

### Requirement: DeviceExecution（V1）
系统 SHALL 支持 DeviceExecution 对象，作为设备侧受控执行的请求载体：
- 最小字段（V1）：
  - deviceExecutionId（UUID）
  - tenantId、spaceId（可空）、createdBySubjectId
  - deviceId
  - toolRef（name+version+depsDigest 的稳定引用）
  - policySnapshotRef（可空，但 V1 建议必填）
  - idempotencyKey（可空）
  - status：pending|claimed|succeeded|failed|canceled
  - requireUserPresence（boolean，默认 false）
  - input（仅结构化对象；服务端存 inputDigest；V1 可选择落 inputJson 但必须受 DLP 审计摘要约束）
  - outputDigest（结构化摘要）
  - evidenceRefs（string[]，引用已存在的 artifactRef 或等价）
  - errorCategory（timeout|policy_violation|tool_error|internal 等）
  - createdAt/updatedAt/claimedAt/completedAt

#### Scenario: 创建 DeviceExecution
- **WHEN** 用户/系统创建一个 device execution 请求
- **THEN** 生成 deviceExecutionId 且 status=pending
- **AND** 写审计（resourceType=device_execution, action=create）

### Requirement: 管理侧创建与查询（V1）
系统 SHALL 提供管理侧 API：
- `POST /device-executions`：创建执行请求
- `GET /device-executions`：列表（分页/limit，按 deviceId 过滤）
- `GET /device-executions/:deviceExecutionId`：详情（含 status、outputDigest、evidenceRefs）
- `POST /device-executions/:deviceExecutionId/cancel`：取消（仅 pending/claimed 可取消）

约束（V1）：
- 必须进行资源级授权（resourceType=device_execution）
- 仅允许访问同一 tenant，且 space 归属一致（如该 execution 绑定 spaceId）

### Requirement: 设备侧领取（poll/claim）（V1）
系统 SHALL 提供设备侧 API 以领取待执行请求：
- `GET /device-agent/executions/pending?limit=...`
  - 返回当前 device 可领取的 pending 列表（按 createdAt 升序或 FIFO）
- `POST /device-agent/executions/:deviceExecutionId/claim`
  - 将 status 从 pending 原子切换为 claimed，并记录 claimedAt

约束（V1）：
- 设备侧必须使用 `Authorization: Device <deviceToken>`
- 仅允许领取 deviceId 匹配自身的执行请求
- 若 requireUserPresence=true，则 claim MUST 返回一个需要本机确认的标志位（V1 仅占位，不实现本机弹窗）

### Requirement: 设备侧回传结果（V1）
系统 SHALL 提供设备侧 API 回传执行结果：
- `POST /device-agent/executions/:deviceExecutionId/result`
  - body：`{ status: "succeeded"|"failed", outputDigest?, errorCategory?, evidenceRefs? }`
  - 成功后记录 completedAt，并将 execution status 更新为终态

约束（V1）：
- 结果回传必须只包含摘要与引用（outputDigest/evidenceRefs），不得上传敏感明文
- 回传必须写审计（resourceType=device_execution, action=result）

### Requirement: ToolRef 与策略约束（V1）
系统 SHALL 在创建与领取/回传过程中强制以下约束：
- 创建时校验 toolRef 指向已发布工具版本
- claim 时校验该 device 的 DevicePolicy.allowedTools（若配置）包含该 toolRef.name
- 执行链路 SHOULD 记录 policySnapshotRef 以支撑回放一致性（V1 可先在审计摘要里携带）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

