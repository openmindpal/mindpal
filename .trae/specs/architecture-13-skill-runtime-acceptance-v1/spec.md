# 架构-13（Skill 运行时：隔离/最小权限/出站治理）验收清单 Spec

## Why
架构-13要求 Skill/Tool 执行具备可证明的隔离与最小权限边界，并在出站与资源消耗上可治理、可审计、可回放，避免外部副作用与合规风险。

## What Changes
- 明确“隔离与出站治理可证明”的验收标准：networkPolicy 严格判定、egress 摘要可追溯、timeout/concurrency/outputBytes 等资源限制可证
- 明确“供应链/版本锁定”的验收标准：scan/trust/sbom/remote-runner gate 在执行入口不可绕过，拒绝具备稳定错误码与审计摘要
- 强化“Capability Envelope（统一能力包络）”契约：将数据域/密钥域/出站域/资源域结构化，并在 API 入队与 worker 执行两端双重校验

## Impact
- Affected specs:
  - skill-runtime-mvp
  - enable-skill-runtime-remote-and-container-hardening-v1
  - finalize-orchestrator-replay-and-skill-sbom-sandbox-v1
  - add-governance-tool-network-policy-v1
  - align-tool-contract-v1
- Affected code:
  - apps/worker/src/workflow/processor/runtime.ts
  - apps/worker/src/workflow/processor/processStep.ts
  - apps/worker/src/workflow/processor/skillSandboxChild.ts
  - apps/api/src/routes/tools.ts
  - apps/api/src/routes/runs.ts（间接：replay/审计可追溯字段）

## ADDED Requirements
### Requirement: 隔离与出站治理必须可证明
系统 SHALL 在所有执行后端（process/container/remote/sandbox）对出站请求按 `networkPolicy` 严格判定，并生成可审计的 egress 摘要。

#### Scenario: 出站严格按 allowlist/rules 判定
- **WHEN** step 在执行中发起出站请求（fetch/http）
- **THEN** 仅当 `networkPolicy.allowedDomains` 与（可选）`networkPolicy.rules` 放行时才允许出站
- **AND** 对被拒绝的出站，step SHALL 以稳定的 errorCategory（如 policy_violation）失败或阻断该请求

#### Scenario: egress 摘要可追溯
- **WHEN** step 执行完成（成功/失败/超时）
- **THEN** steps.outputDigest 与审计 SHALL 包含 `egressSummary`（仅摘要：host/method/pathPrefix 命中与允许/拒绝计数等）
- **AND** 不得包含明文响应体或敏感请求头

### Requirement: 资源限制必须生效
系统 SHALL 在 step 执行侧强制资源限制，至少包含：
- timeout（超时终止，errorCategory=timeout）
- concurrency（并发限制，具备可观测拒绝/重试语义）
- outputBytes（输出大小上限，超限可解释失败）

#### Scenario: timeout 生效
- **WHEN** step 执行耗时超过 timeoutMs
- **THEN** 执行被终止且 step 标记为 timeout
- **AND** 审计摘要包含 timeoutMs 与实际 latencyMs（摘要）

#### Scenario: outputBytes 生效
- **WHEN** 工具输出超过 outputBytes 限制
- **THEN** step SHALL 失败并返回稳定错误码/错误分类
- **AND** 审计摘要不包含超限原始输出，仅包含 outputBytesDigest/键摘要

### Requirement: 供应链/版本锁定（执行前 gate）
系统 SHALL 在执行入口对 Tool/Skill 版本执行 gate 校验，且不可绕过：
- trust（签名/可信密钥）
- scan（依赖扫描策略）
- sbom（SBOM 存在性与摘要）
- isolation/remote-runner（当策略要求时必须满足 container/remote 与 runner 可用）

#### Scenario: gate 拒绝可解释
- **WHEN** 执行的 toolRef 未通过 trust/scan/sbom/isolation gate
- **THEN** 请求 SHALL 被拒绝并返回稳定错误码（如 TRUST_NOT_VERIFIED/SCAN_NOT_PASSED/SBOM_NOT_PRESENT/ISOLATION_REQUIRED）
- **AND** 写入审计摘要（仅包含 gate 状态与缺失项，不含敏感 payload）

### Requirement: Capability Envelope 结构化与双重校验（API + Worker）
系统 SHALL 将执行能力约束统一封装为 `capabilityEnvelope`，并在 API 入队与 worker 执行两端进行一致性校验。

#### Envelope: 结构（V1）
`capabilityEnvelope` SHALL 至少包含：
- `dataDomain`：数据域约束（如 schemaName/entityName 白名单或 scope 信息）
- `secretDomain`：密钥/凭证域约束（如允许的 secret refs 类型与 scope）
- `egressDomain`：出站域约束（networkPolicy 快照与摘要引用）
- `resourceDomain`：资源域约束（timeoutMs/maxConcurrency/maxEgressRequests/outputBytes 等）

#### Scenario: API 入队校验
- **WHEN** API 创建 run/step 并入队执行
- **THEN** `capabilityEnvelope` 必须存在且结构合法
- **AND** `capabilityEnvelope` 必须是治理 effective policy 的子集（不可扩大权限）
- **AND** 失败时返回稳定错误码并不入队

#### Scenario: Worker 执行前复核
- **WHEN** worker 领取 step 准备执行
- **THEN** worker 必须复核 `capabilityEnvelope` 结构与关键约束（networkPolicy/limits）
- **AND** 若不一致或缺失，必须拒绝执行并写审计摘要

## MODIFIED Requirements
### Requirement: 出站/资源/供应链的审计摘要一致性
系统 SHALL 确保 API 入口的决策摘要与 worker 执行侧的实际摘要字段在回放与审计中可对齐（networkPolicyDigest、limitsSnapshot、isolation、supplyChain gates）。

## REMOVED Requirements
（无）

