# Skill 载荷补齐与离线同步高级冲突合并 Spec

## Why
当前 Skill 运行时能力偏“控制面齐、载荷少”，仓库内示例包过少，难以覆盖“进程/容器/远程/沙箱”多隔离形态的真实落地路径与治理接入方式。离线同步虽已具备变更日志、去重、游标与基础冲突处理，但仍缺少更确定性、更自动化、更可视化的高级冲突合并策略，导致协作场景需要大量人工介入。

## What Changes
- Skill 运行时：新增一组“可发布/可治理/可执行”的示例 Skill 包，覆盖沙箱/容器/远程三种隔离形态的最小闭环
- Skill 运行时：补齐示例包的接入契约与运行时限制展示（出站/资源限制/脱敏/幂等），并在审计摘要中形成一致的可追溯信息
- 离线同步：在现有冲突 ticket/mergeRun 基础上新增“确定性自动合并策略”与“可解释合并提案（proposal）”
- 离线同步：提供冲突详情的可视化差异视图与一键套用合并提案能力（治理 UI 与/或工作台 UI）

## Impact
- Affected specs: 架构-13（Skill 运行时）、架构-15（离线同步）
- Affected code:
  - API: skills/*（新增示例包）、apps/api（skill publish/registry 相关路由可能扩展）
  - Worker: apps/worker（动态 skill 执行路径与 runtime backend 适配的示例覆盖）
  - Sync: apps/api/src/routes/sync.ts、apps/api/src/modules/sync/*（合并策略与 proposal）
  - Web: apps/web（冲突详情/合并提案展示与操作）

## ADDED Requirements
### Requirement: 示例 Skill 包覆盖隔离形态
系统 SHALL 在仓库内提供不少于 3 个示例 Skill 包，并且每个包都能完成“发布→启用→执行→审计可追溯”的最小闭环。

#### Scenario: 沙箱示例包（低风险）
- **WHEN** 管理员发布并启用示例包版本
- **THEN** Worker 默认以沙箱路径执行
- **AND** 审计摘要包含 toolRef、artifactRef/depsDigest、egressSummary（如有）、资源限制摘要

#### Scenario: 容器示例包（隔离边界示例）
- **WHEN** 管理员发布并启用容器示例包版本
- **THEN** Worker 按策略选择 container backend（不回退或按配置回退）
- **AND** egress/networkPolicy 规则在容器后端一致生效

#### Scenario: 远程示例包（Remote Runner）
- **WHEN** 管理员注册并启用 remote runner，并发布并启用远程示例包版本
- **THEN** Worker 能通过 remote 协议完成执行并回填一致的 egressSummary/错误分类

### Requirement: Skill 示例包的治理与可解释性
系统 SHALL 为示例包提供最小的治理与可解释信息，确保用户能明确看到“为何可执行/为何被拒绝/如何修复”。

#### Scenario: Gate 拒绝可解释
- **WHEN** 示例包因 trust/scan/eval gate 未满足而被拒绝 enable 或 execute
- **THEN** 返回稳定错误码
- **AND** 输出摘要包含缺失项与最近一次证据引用（不包含敏感明文）

### Requirement: 高级冲突合并策略（确定性 + 自动化）
系统 SHALL 在现有冲突 ticket/mergeRun 基础上提供一套可配置且确定性的合并策略，并能产出可解释的合并提案。

#### Scenario: 自动合并（安全可判定）
- **WHEN** sync.push 产生冲突且冲突类别满足“可自动合并”条件（例如字段不相交、可交换操作等）
- **THEN** 系统生成 mergeProposal（确定性 transcript + mergeDigest）
- **AND** ticket 标记为可自动修复（或自动进入 resolved，取决于策略配置）

#### Scenario: 半自动合并（需要确认）
- **WHEN** 冲突属于“可提出建议但需人工确认”
- **THEN** 系统提供 proposal（包含差异摘要、建议决策、置信度/理由）
- **AND** UI 可一键套用 proposal 并生成新的 mergeRun

### Requirement: 冲突可视化与可操作修复
系统 SHALL 提供冲突详情的可视化差异视图，并支持“套用提案/手工编辑/放弃”三类操作的最小闭环。

#### Scenario: 查看冲突详情
- **WHEN** 用户打开冲突 ticket 详情页
- **THEN** 展示 server/client/base 三方摘要差异（字段级/操作级）
- **AND** 展示 proposal（如存在）与其 mergeDigest

#### Scenario: 套用 proposal 修复
- **WHEN** 用户点击“应用提案并提交”
- **THEN** 生成新的 mergeRun 并更新 ticket 状态
- **AND** 审计摘要包含 ticketId/mergeId/mergeDigest/traceId/requestId 的关联字段

## MODIFIED Requirements
### Requirement: sync.push 冲突输出增强（非破坏性扩展）
系统 SHALL 在保持现有 sync.push 返回结构可兼容的前提下，新增可选字段以携带 mergeProposal 摘要与可操作提示。

## REMOVED Requirements
无

