# Skill Runtime 强隔离（Remote Runner + 容器硬化 + 细粒度网络策略）Spec

## Why
现有 Skill Runtime 已具备进程沙箱与容器执行能力，但“remote 隔离运行时”缺失，且供应链信任与出站治理仍缺少治理化闭环与更强的运行时边界，距离《架构-13-Skill运行时-隔离最小权限与出站治理.md》的 V2/V3 目标仍有差距。

## What Changes
- 新增 Remote Runner：支持将动态 Skill/Tool 的执行委派到远程运行时（remote），通过稳定的 ExecutionRequest/ExecutionResult 契约交互
- 容器执行硬化：将容器执行从“可选后端”提升为生产默认，并在失败时按策略允许/禁止回退到进程沙箱
- 供应链治理闭环：把“可信公钥/信任策略”从环境变量提升为治理对象（可审计、可回滚、按租户隔离），并将执行前信任校验结果写入审计摘要
- 依赖扫描闭环：把扫描状态作为强制 gate（执行与启用/发布），并提供可解释的阻断原因摘要查询
- 细粒度网络策略 V2：在现有 allowedDomains 的基础上，支持更细粒度 rule（host + pathPrefix + methods，可扩展 scheme/port），并保证 process/container/remote 三种后端执行时一致生效（以运行时可证明边界为准）

## Impact
- Affected specs:
  - Skill 运行时（隔离/最小权限/出站治理）
  - Tool/Skill 供应链治理（签名/扫描/信任策略）
  - Governance（启用/发布 gate、只读可解释性）
  - Audit（执行可追溯、信任/扫描/出站摘要）
- Affected code:
  - Worker：动态 Skill 执行器（后端选择、remote 适配、容器硬化策略）、出站策略统一口径
  - API：治理接口（trusted keys/runner registry/scan 状态只读与 gate 判定），以及工具启用/发布 gate 的联动
  - DB：remote runners、trusted keys、scan 状态/摘要（最小新增）

## ADDED Requirements

### Requirement: Remote Runner 执行契约
系统 SHALL 支持 runtimeBackend=remote 的执行后端，并使用稳定契约进行交互：
- ExecutionRequest：{ toolRef, tenantId, spaceId?, subjectId?, traceId, idempotencyKey?, input, limits, networkPolicy, artifactRef, depsDigest, policySnapshotRef? }
- ExecutionResult：{ status, output, outputDigest, errorCategory, latencyMs, egressSummary, runtimeBackend, degraded }

#### Scenario: remote 执行成功
- **WHEN** worker 选择 runtimeBackend=remote 执行某个动态 toolRef
- **THEN** 系统将 ExecutionRequest 发送给指定 Remote Runner
- **AND** 返回的 ExecutionResult 被写入 step 输出摘要与审计摘要（不含敏感原文）

#### Scenario: remote 运行时不可用
- **WHEN** Remote Runner 不可达/超时/返回无效响应
- **THEN** 系统 MUST 以稳定错误分类失败（例如 errorCategory=runtime_unavailable 或等价分类）
- **AND** 若配置允许降级（degraded=true），可回退到 container/process（按治理策略决定）并在审计摘要中标明降级原因

### Requirement: 容器执行默认启用与回退策略
系统 SHALL 在生产环境默认使用 container 后端执行动态 Skill/Tool，并通过明确策略控制是否允许回退。

#### Scenario: 生产环境默认容器
- **WHEN** 在生产环境执行动态 toolRef
- **THEN** 默认选择 runtimeBackend=container

#### Scenario: 生产环境禁止回退
- **WHEN** container 后端执行失败
- **THEN** 若回退策略为禁止，系统 MUST 直接失败并返回稳定错误码/分类

### Requirement: 可信公钥治理化（Trust Keys as Governance Object）
系统 SHALL 支持以治理对象形式管理“可信签名公钥”，按 tenant 隔离，并提供启用/禁用/轮换能力；执行前签名校验必须引用治理配置而非仅依赖环境变量。

#### Scenario: 信任未验证阻断执行
- **WHEN** toolRef 对应 artifact 的签名缺失或校验失败
- **THEN** 系统 MUST 阻断执行并返回稳定错误码（例如 TRUST_NOT_VERIFIED 或等价）
- **AND** 审计摘要中记录 trustDecision 与失败原因摘要（不记录签名原文/代码）

### Requirement: 扫描状态强制 gate（Non-bypassable Scan Gate）
系统 SHALL 将依赖扫描状态作为强制 gate：
- 执行 gate：未通过扫描的 toolRef 不得执行
- 治理 gate：未通过扫描的 toolRef 不得启用/发布（按风险等级/策略配置）

#### Scenario: 扫描未通过阻断启用/执行
- **WHEN** toolRef 的最新扫描状态为 failed/blocked/unknown（以实现定义）
- **THEN** 启用/执行 MUST 被拒绝，并返回稳定错误码（例如 SCAN_NOT_PASSED 或等价）
- **AND** 可通过治理只读接口查询到阻断原因摘要

### Requirement: 细粒度网络策略一致性（跨后端）
系统 SHALL 对 networkPolicy 执行一致的最小化约束，并在执行回执中输出 egressSummary：
- 至少支持 rule：host、pathPrefix（可选）、methods（可选）
- 禁止出站默认拒绝，除非命中 allowedDomains 或 rule

#### Scenario: rule 命中允许
- **WHEN** tool 执行对 URL 发起请求，且命中网络策略 rule
- **THEN** 允许出站，并在 egressSummary 记录 {host, method, allowed=true, status?}

#### Scenario: 未命中拒绝
- **WHEN** tool 执行对 URL 发起请求，且未命中 allowedDomains/rules
- **THEN** 拒绝出站并返回稳定分类（policy_violation）
- **AND** egressSummary 记录 {host, method, allowed=false, errorCategory}

## MODIFIED Requirements

### Requirement: Tool 执行审计摘要（扩展）
tool:execute 审计事件 SHALL 额外包含：
- runtimeBackend（process/container/remote/local）
- degraded（是否降级）
- trustDecision/scanDecision（摘要级）
- egressSummary（最小化）

## REMOVED Requirements
（无）

