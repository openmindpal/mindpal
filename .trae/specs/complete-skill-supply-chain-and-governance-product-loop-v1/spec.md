# Skill Runtime 强隔离/供应链闭环 + 回放→评测→准入治理产品闭环 Spec

## Why

当前仓库已具备动态 Skill、出站白名单、依赖扫描与治理模块（replay/changeset/eval），但“默认隔离执行 + 可验证供应链 + 强制准入流水线 + 日常工作流体验”仍未形成闭环，存在默认安全边界不足与治理体验割裂的问题。

## What Changes

* Skill Runtime：执行默认进入容器/沙箱隔离（不再依赖 worker 宿主进程内直接执行动态包）

* Supply Chain：Skill/Tool 产物签名校验 + 可追溯 provenance（发布→投递→执行全链路可验证）

* 准入强制化：治理流水线对“签名/扫描/评测门槛”做强制 gating（不可绕过）

* 产品闭环：把回放→评测→准入门槛打通成日常工作流（从回放直接沉淀评测用例、触发评测、阻断/放行发布并可解释）

## Impact

* Affected specs:

  * Skill 包与动态加载（artifactRef/depsDigest/扫描摘要）

  * Skill Runtime（出站治理/限流/资源配额/安全门槛）

  * Governance（changeset/preflight/release、eval admission、replay）

  * Audit（执行可追溯、供应链校验、准入决策）

* Affected code:

  * Worker：执行器（从“宿主执行”→“默认沙箱执行”）、签名校验、能力限制

  * API：发布/启用/治理流水线的 gate 与错误码、评测与回放联动 API

  * Web：治理控制台（replay/eval/changeset）串联与日常操作入口

  * DB：签名/证明/provenance 与 gate 状态的持久化（按最小新增）

## ADDED Requirements

### Requirement: 默认沙箱隔离执行（Default Sandbox）

系统 SHALL 对动态 Skill/Tool 版本的执行默认使用容器/沙箱隔离运行时，而不是在 worker 宿主进程内直接 `require/import` 执行。

#### Scenario: 动态包默认沙箱执行

* **WHEN** worker 执行任意绑定 `artifactRef` 的 toolRef

* **THEN** 执行 MUST 发生在沙箱内

* **AND** 沙箱对文件系统/进程/环境变量具备最小权限边界（默认无写宿主、无读取宿主敏感路径）

* **AND** 执行回执包含 runtime 摘要（latencyMs/egressSummary/limitsSnapshot）且不包含敏感原文

#### Scenario: 沙箱能力边界

* **WHEN** tool 未显式声明允许的能力（例如出站域名、临时目录写入）

* **THEN** 沙箱 MUST 拒绝对应能力并返回 `errorCategory=policy_violation`（或等价稳定分类）

### Requirement: 产物签名与可验证供应链（Artifact Signing + Verification）

系统 SHALL 支持并强制执行对 Skill/Tool 产物的签名校验，以形成从发布到执行的可验证闭环：

* 发布侧生成或接收产物摘要（digest）并生成签名（signature）

* Worker 执行前验证签名、摘要与 registry 中绑定关系一致

* 记录 provenance（摘要字段，不含敏感原文/代码）

#### Scenario: 签名校验失败阻断执行

* **WHEN** worker 发现 artifact 的签名无效/缺失/与 digest 不一致

* **THEN** worker MUST 拒绝执行该 toolRef

* **AND** 写审计事件（含 `trustDecision`/失败原因摘要）

### Requirement: 扫描/信任策略与准入门槛强制化（Non-bypassable Gate）

系统 SHALL 让“扫描结果门槛、签名信任策略、评测准入”成为治理流水线的强制 gate：

* 治理侧 enable/release 等动作不得绕过 gate

* gate 的判定与失败原因必须可解释、可追溯（摘要）

#### Scenario: 未通过门槛拒绝启用/发布

* **WHEN** Tool Version 未满足签名信任策略或扫描门槛或 required eval suites 未通过

* **THEN** 治理动作 MUST 被拒绝，并返回稳定错误码（例如 `TRUST_NOT_VERIFIED`/`SCAN_NOT_PASSED`/`EVAL_NOT_PASSED` 或等价）

### Requirement: 回放→评测→准入的日常工作流（Product Loop）

系统 SHALL 提供从回放视图直接沉淀评测与准入的日常路径：

* 从 Run Replay 生成 Eval Case（仅摘要：inputDigest/outputDigest/toolRef/policySnapshotRef 等）

* 可一键触发 Eval Run，并将结果回写到 Changeset 的 preflight/release gate 展示

* 将 gate 的“缺什么/怎么补齐/最近一次证据”在 UI 上可操作化

#### Scenario: 从回放生成评测用例

* **WHEN** 用户在 Run 回放视图选择一个 step 或 run

* **THEN** 系统允许创建或追加到指定 EvalSuite 的 EvalCase（仅摘要）

* **AND** 返回可追溯引用（suiteId/caseId/evidenceDigest）

#### Scenario: changeset 流水线内触发补齐评测

* **WHEN** 用户在 changeset pipeline 页面看到“评测未通过/缺失”

* **THEN** 页面提供“触发评测”入口

* **AND** 评测完成后 pipeline 状态可刷新并显示最近一次 run 的摘要与证据引用

## MODIFIED Requirements

### Requirement: Tool/Skill 发布与启用（扩展）

`publish/enable`（或等价治理动作）SHALL 扩展支持并展示供应链校验字段：

* artifact digest、signature 状态、scanSummary 摘要、trustDecision 摘要

* 未满足 gate 时拒绝启用/发布并返回稳定错误码

### Requirement: Replay 与治理联动（扩展）

Run Replay 视图 SHALL 增加“生成评测用例/触发评测/查看准入状态”的联动入口，且仅使用摘要字段。

## REMOVED Requirements

### Requirement: 动态 Skill 在 worker 宿主进程内直接执行

**Reason**：无法提供默认强隔离与最小权限边界，且难以形成可验证供应链闭环。
**Migration**：

* 动态包默认改为沙箱执行；内置实现可保持宿主执行但需满足同等出站与资源限制

* 若存在短期兼容开关，必须仅限治理侧显式开启且可审计，并计划性淘汰

