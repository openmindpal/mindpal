# Safety/DLP 全链路治理 V2 + Skill Runtime 闭环加固 V2 Spec

## Why
当前系统已具备 DLP（脱敏/deny）与提示注入扫描/deny 的 MVP，以及 Skill 子进程沙箱与基础出站白名单，但仍缺少“全链路策略化”的统一安全门与“运行时工程闭环”（供应链扫描、资源配额、治理禁用/回滚等），导致高风险路径依赖局部实现而难以保证一致性、可运营与可追责。

## What Changes
- Safety/DLP V2：引入统一 Safety Gate（策略化扫描→分级处置→审计对齐），覆盖 tool 入参/出参、orchestrator 执行、connector/channel 外发与模型输出等关键目标。
- 外发最小化 V1：为“外发/出站”建立统一的最小化与脱敏规则（默认不外发敏感字段/密钥模式），并对外发拒绝提供稳定错误码与审计摘要。
- Skill Runtime V2：补齐动态 Skill 包与工具版本的工程闭环：来源/签名校验、依赖/风险扫描摘要、资源配额扩展、出站治理与一键禁用/回滚（至少阻断新执行）。
- 治理可见性：提供只读查询能力查看 Safety 命中摘要、Skill 包扫描摘要与禁用原因（MVP 形态）。

## Impact
- Affected specs:
  - 安全中枢（Safety/DLP 与内容治理）
  - Skill 运行时（隔离/最小权限/出站治理/供应链）
  - 连接器与密钥托管（外发治理）
  - 审计域（拒绝原因/命中摘要/一致字段）
- Affected code:
  - API：统一安全门拦截点（orchestrator/tools/connectors/channels/models 等）
  - Worker：tool/skill 执行与外发桥接路径（出站/回执/审计写入前）
  - Shared：Safety/DLP 扫描与摘要结构（可复用）
  - DB：新增或扩展扫描摘要/禁用状态的持久化（以现有表为基础增量扩展）

## ADDED Requirements

### Requirement: Safety Gate（统一安全门，V2）
系统 SHALL 提供统一的 Safety Gate，对指定 target 执行“扫描 → 分级处置 → 审计摘要固化”。

- Safety Gate 输入 SHALL 包含：{ target, subject, tenantId, spaceId?, input?, output?, egress? }（字段以实现为准）。
- Safety Gate 扫描 SHALL 至少包含：
  - DLP scan（token/key/email/phone 等，沿用现有引擎）
  - Prompt Injection scan（沿用现有引擎）
- Safety Gate 输出 SHALL 为结构化摘要 `safetySummary`，至少包含：
  - `dlpSummary`（类型/计数，不含原文）
  - `promptInjectionSummary`（hitCount/maxSeverity/mode/result）
  - `decision`（allowed/denied）
  - `actions`（例如 redactedFields/blockedReasons 的摘要，不含敏感原文）

#### Scenario: tool.execute 入参触发提示注入 deny
- **WHEN** SAFETY_PI_MODE=deny 且 target=tool:execute 且命中应拒绝的注入模式
- **THEN** 系统拒绝执行并返回稳定 errorCode=SAFETY_PROMPT_INJECTION_DENIED
- **AND** 审计写入 safetySummary（不包含原文）

#### Scenario: 任意目标发生 DLP 脱敏
- **WHEN** Safety Gate 对 input/output/egress 进行扫描且命中敏感信息
- **THEN** 系统对返回/审计摘要执行脱敏
- **AND** safetySummary.dlpSummary 记录命中类型与计数

### Requirement: Safety 分级处置（V2 最小分级）
系统 SHALL 支持最小的分级处置策略（以 target 为维度配置），至少包含：
- `audit_only`：允许继续，但写入 safetySummary 与审计摘要脱敏
- `deny_on_high_risk`：对高风险命中（至少 token/key 与高严重度 prompt injection）拒绝

#### Scenario: connector 外发命中 token/key 被拒绝
- **WHEN** target=connector:egress 且处置策略为 deny_on_high_risk 且命中 token/key
- **THEN** 系统拒绝外发并返回稳定 errorCode=DLP_DENIED（或安全统一错误码，二选一并保持稳定）
- **AND** 审计记录拒绝原因与 safetySummary（不含原文）

### Requirement: 外发最小化（V1）
系统 SHALL 对所有“外发/出站”路径执行最小化规则：
- 外发内容 MUST 先通过 Safety Gate（target=connector:egress 或 channel:send 等）。
- 默认策略 SHALL 执行脱敏并禁止外发密钥/令牌模式与高风险片段（以 DLP 规则为准）。
- 外发 payload 的审计摘要 MUST 只记录结构化统计与哈希/长度等非敏感摘要，不记录明文大段内容（以实现为准）。

#### Scenario: channel.send 外发被最小化
- **WHEN** 系统向 IM/通知渠道发送包含敏感片段的文本
- **THEN** 外发文本被脱敏或被拒绝（按策略），并写入 safetySummary 与审计摘要

### Requirement: Skill 包与工具版本扫描摘要（V2）
系统 SHALL 为动态 Skill 包（及/或 tool version）生成并持久化扫描摘要：
- 扫描摘要 SHALL 至少包含：依赖数量、是否包含原生模块、是否包含 install scripts、风险等级（low/medium/high）与命中规则摘要。
- 扫描摘要 MUST 不包含：源代码全文、依赖文件全文、任何密钥明文。
- 生产环境（或受控模式）下，执行动态 Skill 前 MUST 校验：
  - 包信任策略（来源/签名/allowlist 等，沿用并可增强）
  - 扫描摘要未命中“阻断级”规则（例如 high risk）

#### Scenario: high risk skill 包被阻断
- **WHEN** 某 skill 包扫描结果为 high risk 且执行环境要求阻断
- **THEN** 系统拒绝执行并返回稳定 errorCode（以实现为准，必须可区分于 AUTH/DLP）
- **AND** 审计记录阻断原因摘要与包引用（不含包内容）

### Requirement: 资源配额扩展（V2）
系统 SHALL 在现有 timeoutMs/maxConcurrency 基础上支持最小资源配额扩展（至少两项）：
- `maxOutputBytes`：限制单次执行输出体积（含 stdout/IPC payload，口径以实现为准）
- `maxEgressRequests`：限制单次执行的出站请求次数（或等价计数）

#### Scenario: 输出超限被终止
- **WHEN** tool/skill 输出超过 maxOutputBytes
- **THEN** 运行时终止并返回 errorCategory=resource_limit
- **AND** 审计包含 limitsSnapshot 与超限摘要（不含超限原文）

### Requirement: 一键禁用与回滚（V2 最小闭环）
系统 SHALL 支持对动态 Skill 包/工具版本的治理禁用与回滚（最小闭环）：
- 禁用 SHALL 立即阻断新执行（API 与 worker 均需生效）。
- 回滚 SHALL 支持将 active 版本切换回上一已发布版本（仅限已通过扫描/信任策略的版本）。
- 禁用/回滚动作 MUST 写入审计（含操作者、目标、原因摘要、变更前后引用）。

#### Scenario: 禁用后新执行被拒绝
- **WHEN** 管理员禁用某 toolRef 或 skillPackageVersion
- **THEN** 后续任何新 execution 请求被拒绝并返回稳定 errorCode=TOOL_DISABLED（或等价错误码）

## MODIFIED Requirements

### Requirement: 统一请求链路的安全摘要（扩展）
所有涉及 tool execute / orchestrator execute / connector egress / channel send / model invoke 的审计事件 SHALL 附带 safetySummary（字段可选但结构稳定），以保证跨模块一致的可追责摘要。

## REMOVED Requirements
（无）

