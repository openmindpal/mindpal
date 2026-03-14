# 安全中枢（Safety/DLP 与内容治理）MVP Spec

## Why
平台已具备统一请求链路、审计、受控工具执行、模型网关、连接器与出站治理，但“内容治理”仍缺少统一执行点：敏感信息识别与脱敏未系统化，容易在审计摘要、日志、证据链、模型输出中泄露。需要按《架构-12-安全中枢-SafetyDLP与内容治理.md》落地 MVP：**敏感信息识别 + 基础脱敏 + 审计对齐**。

## What Changes
- 新增 DLP 引擎（MVP）：基于规则的敏感信息识别与脱敏（token/key/email/phone 等）
- 新增统一执行点（MVP）：
  - API：写审计前对 inputDigest/outputDigest 统一脱敏
  - Worker：写审计摘要前统一脱敏
  - Knowledge：返回 evidence.snippet 前脱敏（不影响原文存储）
  - Model Gateway：返回 outputText 前脱敏（MVP 可先对 mock provider 生效）
- 新增审计字段（MVP）：dlpSummary（命中类型/计数/处置）
- 新增配置（MVP）：DLP_MODE=audit_only|deny（默认 audit_only）
- 新增配置（MVP）：DLP_DENY_TARGETS（仅对目标动作启用 deny，默认 model:invoke,tool:execute）

## Impact
- Affected specs:
  - 安全中枢（敏感信息识别/脱敏/审计可追溯）
  - 审计域（摘要脱敏与命中摘要）
  - 知识层（证据链 snippet 脱敏）
  - 模型网关（输出脱敏）
- Affected code:
  - API：server hooks（审计写入前）与相关路由（knowledge/models）
  - Worker：审计写入路径（workflow/knowledge index）
  - Shared：新增可复用 redaction 库（建议放 shared）

## ADDED Requirements

### Requirement: 敏感信息识别（MVP）
系统 SHALL 识别以下敏感信息类型（MVP 最小集合）：
- API Key / Token：形如 `sk-...`、`Bearer ...`、常见云厂商 key 前缀（以实现为准）
- Email：`name@domain`
- Phone：国际/国内常见号码（以实现为准）
- High-entropy 片段（可选，MVP 可不启用）

#### Scenario: 输入包含密钥
- **WHEN** 请求入参/出参摘要包含密钥模式
- **THEN** dlp 引擎返回命中摘要（类型/数量）且被脱敏

### Requirement: 脱敏策略（MVP）
系统 SHALL 对命中敏感信息执行脱敏：
- 默认策略：中间替换为 `***REDACTED***`（保留少量前后缀用于排查，可选）
- 脱敏必须作用于：审计摘要、证据链 snippet、模型输出（MVP 范围）
- 脱敏不得修改数据库中业务原文（例如 Knowledge Document 原文）

#### Scenario: 审计摘要脱敏
- **WHEN** 审计写入前执行脱敏
- **THEN** audit_events.input_digest/output_digest 不含敏感原文

### Requirement: 统一执行点（MVP）
系统 SHALL 在以下位置执行 DLP（顺序：识别→脱敏→生成 dlpSummary）：
- API：审计写入前（统一 hook）
- Worker：审计写入前（统一函数/拦截点）
- Knowledge：返回 evidence.snippet 前
- Model Gateway：返回 outputText 前

### Requirement: DLP 模式（MVP）
系统 SHALL 支持两种模式：
- `audit_only`：只脱敏并写 dlpSummary，不拒绝请求
- `deny`：仅对 DLP_DENY_TARGETS 指定的高风险动作，当命中 “token/key” 类敏感信息时拒绝（返回稳定 errorCode=DLP_DENIED），并写审计（result=denied，errorCategory=policy_violation）

#### Scenario: deny 模式拒绝外发
- **WHEN** DLP_MODE=deny 且响应/外发内容命中密钥
- **THEN** 请求被拒绝并可审计（不泄露原文）

### Requirement: 审计对齐（MVP）
系统 SHALL 将 DLP 命中摘要写入审计：
- outputDigest 增加 `dlpSummary`（类型与计数，不包含原文）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）
