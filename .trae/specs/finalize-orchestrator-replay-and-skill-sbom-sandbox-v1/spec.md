# AI 编排封存/回放闭环与 Skill 供应链隔离强化 V1 Spec

## Why
当前系统已具备 orchestrator/runs/steps/replay 与基础治理 gate，但仍缺少“非确定性封存语义”“证据链强约束的终态形态”“回放→回归评测→准入的可重复闭环”，以及 Skill 侧“可复现供应链 + SBOM + 系统级沙箱隔离”的系统化落地。

## What Changes
- 运行封存（Sealing）语义（V1）：
  - 为 orchestrator run/step 与 workflow run/step 引入“封存视图”与稳定 digest 计算规则
  - 明确允许的非确定性字段集合（例如 traceId、时间戳、requestId），并将其从 sealedDigest 计算中剔除
  - 回放与评测默认基于封存视图，而非实时查询/可变引用
- 证据链强约束终态（V1）：
  - 统一定义“检索发生 → 必须携带 evidenceRefs”的强约束覆盖范围（编排输出、workflow step 输出、eval case 输出）
  - 将“缺失证据链”从业务语义上的失败与审计可追溯语义固定为稳定契约（错误码/事件）
- 回归评测闭环强化（V1）：
  - EvalCase 生成必须绑定封存视图摘要（sealedDigests + evidence digests），以支持可重复回归
  - 准入 gate 可选择基于“最近一次通过的 EvalRun”与“封存 digest 一致性”共同决定放行
- Skill 隔离与供应链可复现（V1）：
  - 发布时生成并持久化 SBOM（最小可用：依赖清单 + artifact 文件摘要 + 构建元数据摘要）
  - 执行与 enable/release 治理动作新增“SBOM 必备/校验”的 gate（按 scope/环境策略）
  - 运行时返回/审计“隔离级别”与“供应链校验结论”，用于回放与追责
- **BREAKING**：
  - 对启用“封存/证据链强约束/供应链 SBOM gate”的路径，缺失 sealedDigest 或 evidenceRefs 或 SBOM 的动作将被拒绝或降级为不可发布/不可执行（见 Requirements）。

## Impact
- Affected specs:
  - workflow-replay-v1（回放输出契约升级为封存优先）
  - orchestrator-turn-digests-v1（摘要留存与绑定校验）
  - harden-abac-debug-and-evidence-contract-v1（证据链强约束扩展为终态）
  - governance-eval-admission-mvp、complete-skill-supply-chain-and-governance-product-loop-v1（回放→评测→准入链路强化）
  - enable-skill-runtime-remote-and-container-hardening-v1（隔离级别与运行时治理语义对齐）
- Affected code:
  - DB：新增/扩展封存与供应链元数据字段（runs/steps、skill/tool versions、eval cases）
  - API：replay/eval/governance endpoints 输出扩展（sealed view、contract gates、SBOM/隔离信息）
  - Worker：执行时产出封存摘要、证据链、隔离级别与供应链校验事件
  - Web：治理与回放/评测页面展示封存/证据链/SBOM/隔离与 gate 解释

## ADDED Requirements

### Requirement: SealedViewV1
系统 SHALL 为 run/step 提供封存视图（V1），并以其作为回放与评测的默认数据源。

封存视图（V1）SHALL 至少包含：
- `sealedAt`: ISO 时间戳
- `sealedSchemaVersion`: number（从 1 起）
- `sealedInputDigest`: { len: number; sha256_8: string }
- `sealedOutputDigest`: { len: number; sha256_8: string }
- `nondeterminismPolicy`: { ignoredJsonPaths: string[]; notes?: string }
- `supplyChain`: { artifactDigest?: string; signatureDigest?: string; sbomDigest?: string; verified: boolean }
- `isolation`: { level: "process" | "container" | "remote"; enforced: boolean }

#### Scenario: 封存 digest 的稳定性
- **WHEN** 相同的 run/step 输出在非确定性字段（如 traceId、时间戳）变化
- **THEN** `sealedOutputDigest` 不变
- **AND** 变化字段仅影响非封存字段（例如 debug/timing）

#### Scenario: legacy 记录兼容
- **WHEN** 读取历史 run/step 且无封存字段
- **THEN** 系统返回 `sealStatus="legacy"`（或等价字段）
- **AND** 回放/评测明确标注“非封存来源”，不得伪装为 sealed

### Requirement: ReplayUsesSealedViewV1
系统 SHALL 将回放（replay）默认切换为封存视图：
- `GET /runs/:runId/replay`（及等价 workflow replay）返回中包含 `sealStatus` 与 `sealed*Digest`
- timeline 聚合允许包含审计事件，但“结果解释/评测输入”必须以 sealed view 为准

#### Scenario: 回放不触发副作用且可重复
- **WHEN** 用户多次调用 replay
- **THEN** 输出中的 sealed 摘要字段稳定一致
- **AND** 不产生新的执行与外部副作用

### Requirement: EvidencePolicyFinalV1
系统 SHALL 固化证据链强约束（终态 V1）：
- **WHEN** 任一 step/run 在本次链路中产生检索（retrievalLogId 存在或显式标记 `retrievalUsed=true`）
- **THEN** 最终答案/step 输出 MUST 携带 `evidenceRefs[]`（至少 1 条）
- **AND** `evidenceRefs[].retrievalLogId` MUST 指向本次运行产生的检索日志
- **IF NOT** 满足
  - 执行结果 MUST 标记为失败或不可发布（按执行类型定义）
  - 并写审计事件（例如 `knowledge.answer.denied`）与稳定错误码 `EVIDENCE_REQUIRED`

#### Scenario: EvalCase 继承证据链要求
- **WHEN** 从 replay/封存视图生成 EvalCase 且存在检索
- **THEN** EvalCase MUST 仅保存证据链摘要字段（sourceRef + snippetDigest + location + rankReason）
- **AND** 不得保存原文与 secret

### Requirement: RegressionEvalLoopFinalV1
系统 SHALL 强化“回放→回归评测→准入”闭环：
- EvalCase 生成 MUST 绑定封存摘要（sealedInputDigest/sealedOutputDigest 与 evidence digests）
- EvalRun 结果 MUST 可追溯到“封存来源 run/step”与其 sealed digest
- 治理准入 gate（例如 enable/release/changeset release）可配置为：
  - 必须存在最近一次 succeeded 的 EvalRun（范围/时间窗可配置）
  - 且其引用的 sealed digests 与当前版本 digest 一致（或属于允许的 nondeterminismPolicy）

#### Scenario: 评测准入可解释拒绝
- **WHEN** gate 需要评测但最近一次 EvalRun 不存在/失败/过期
- **THEN** 拒绝发布并返回稳定错误码（例如 `EVAL_NOT_PASSED` 或新增 `EVAL_REQUIRED`）
- **AND** preflight/pipeline 可解释展示缺失项与最近一次证据

### Requirement: SkillSBOMV1
系统 SHALL 在 Skill/Tool 版本发布（或产物导入）阶段生成并持久化 SBOM（V1）：
- SBOM（V1）至少包含：
  - `format`: string（例如 `sbom.v1`）
  - `components[]`: { name: string; version?: string; type: "npm" | "python" | "os" | "other"; digest?: string }
  - `artifactFilesDigest`: { sha256_8: string; count: number }
  - `buildProvenanceDigest`: { sha256_8: string }
- SBOM 输出不得包含 secret（token、key、connector 明文）
 - SBOM gate 由运行时/治理侧策略开关控制（例如 `SKILL_SBOM_MODE=deny` 时强制要求 SBOM；默认 `audit_only` 用于兼容存量）

#### Scenario: SBOM 在治理侧可审计与可展示
- **WHEN** 完成发布
- **THEN** 治理侧可读取该版本的 sbomDigest 与摘要信息
- **AND** 执行审计事件包含 sbomDigest（或标记缺失）

### Requirement: SkillIsolationLevelV1
系统 SHALL 将执行隔离级别纳入可追溯契约：
- 每次 skill 执行 MUST 产出 `isolation.level` 与 `isolation.enforced`
- 治理策略可配置“某些范围/环境必须使用 container/remote 隔离级别”
- 不满足时 enable/release/execute MUST 被拒绝（稳定错误码，例如 `ISOLATION_REQUIRED`）

## MODIFIED Requirements

### Requirement: GovernancePreflightGateSummaryV1（扩展）
preflight/pipeline 输出 SHOULD 增加封存/证据链/SBOM/隔离相关的 gate 摘要：
- `gateType`: `"seal" | "evidence" | "sbom" | "isolation" | ...`
- `status`: `"pass" | "fail" | "warn"`
- `details`: 可解释缺失项（不包含敏感信息）

## REMOVED Requirements
无
