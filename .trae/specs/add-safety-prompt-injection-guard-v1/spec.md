# Prompt Injection Guard（提示注入防护）V1 Spec

## Why
当前平台已具备统一请求链路、RBAC/Policy Snapshot、审计与基础 DLP（脱敏/deny 模式）。但《架构设计.md》明确要求安全中枢具备“提示注入防护、工具入参/出参治理、外发策略”。目前缺少对“提示注入（Prompt Injection）”的统一检测与处置点，导致高风险工具执行与外发行为可能被恶意指令诱导，难以治理与复盘。

因此需要落地 Prompt Injection Guard V1：提供可配置的检测与处置（audit_only/deny），并与审计、工作流执行链路对齐。

## What Changes
- 新增提示注入检测引擎（MVP）：基于规则/关键词/结构特征的启发式检测（不依赖第三方模型）
- 新增统一执行点（V1）：
  - Orchestrator：`POST /orchestrator/turn` 与 `POST /orchestrator/execute` 的入参检测
  - Tool 执行：`POST /tools/:toolRef/execute` 的 inputDraft/input 检测
- 新增配置（V1）：
  - `SAFETY_PI_MODE=audit_only|deny`（默认 audit_only）
  - `SAFETY_PI_DENY_TARGETS`（默认 `tool:execute,orchestrator:execute`）
- 新增审计字段（V1）：`safetySummary.promptInjection`（命中类型/计数/处置，不包含原文）
- 错误规范（V1）：deny 时返回稳定 `errorCode=SAFETY_PROMPT_INJECTION_DENIED`

## Impact
- Affected specs:
  - 安全中枢（提示注入防护的统一落点）
  - AI 编排层（turn/execute 的安全门禁与可解释审计）
  - 工具执行链路（execute 入参治理）
  - 审计域（safetySummary 进入审计摘要）
- Affected code:
  - API：orchestrator routes、tools routes、server audit hook（如需统一写入摘要）
  - Shared：新增 safety 检测与摘要结构（建议放 shared）
  - Tests：e2e 覆盖 audit_only 与 deny

## ADDED Requirements

### Requirement: PromptInjectionDetectionV1
系统 SHALL 提供提示注入检测函数（V1）：
- 输入：`text: string`
- 输出：`{ hits: Array<{ ruleId: string; severity: "low"|"medium"|"high" }>, score: number }`

检测规则（V1 最小集合） SHOULD 覆盖：
- “忽略之前指令/系统消息/开发者消息”等指令劫持语句
- “泄露密钥/输出系统提示/显示隐藏内容”等越权请求语句
- “执行高风险动作/外发/删除/转账”等诱导语句（以规则库为准）

### Requirement: PromptInjectionModeV1
系统 SHALL 支持两种模式：
- `audit_only`：记录 safetySummary，不拒绝请求
- `deny`：对 `SAFETY_PI_DENY_TARGETS` 指定的目标，当命中 `severity=high`（或 score 超阈值）时拒绝

### Requirement: OrchestratorTurnGuardV1
- **WHEN** `POST /orchestrator/turn` 收到 `message`
- **THEN** 系统 MUST 对 message 执行提示注入检测
- **AND** 在审计摘要中写入 `safetySummary.promptInjection`（至少包含 hitCount、maxSeverity、mode、result）

### Requirement: OrchestratorExecuteGuardV1
- **WHEN** `POST /orchestrator/execute` 收到执行 input
- **THEN** 系统 MUST 对执行 input 执行提示注入检测
- **AND** 若 `SAFETY_PI_MODE=deny` 且目标包含 `orchestrator:execute` 且命中高危
  - **THEN** 返回 400（或 403，按既有错误风格），`errorCode=SAFETY_PROMPT_INJECTION_DENIED`
  - **AND** 写审计（result=denied，errorCategory=policy_violation），不得包含原文

### Requirement: ToolExecuteGuardV1
- **WHEN** `POST /tools/:toolRef/execute` 收到 `inputDraft` 或 `input`
- **THEN** 系统 MUST 对其执行提示注入检测
- **AND** 若 `SAFETY_PI_MODE=deny` 且目标包含 `tool:execute` 且命中高危
  - **THEN** 拒绝并返回 `SAFETY_PROMPT_INJECTION_DENIED`
  - **AND** 写审计（不泄露原文）

### Requirement: SafetySummaryAuditV1
系统 SHALL 在审计摘要输出中记录提示注入检测结果：
- 字段：`safetySummary: { promptInjection: { hitCount: number; maxSeverity: string; mode: string; result: "allowed"|"denied" } }`
- MUST 不包含被检测的原文内容

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

