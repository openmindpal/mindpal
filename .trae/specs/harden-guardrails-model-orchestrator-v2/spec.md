# 平台 V2：护栏上线化 + 模型生态 + 编排闭环 Spec

## Why
当前仓库已具备“统一请求链路 + RBAC/Policy + 审计 + DLP + Workflow/队列 + Skill 子进程沙箱 + Model Gateway MVP + 多智能体协作 MVP”的骨架，但仍缺少可上线级护栏（隔离/配额/供应链/细粒度出站）、更完整的模型生态（provider/路由/预算），以及从启发式升级到可回放的“计划-检索-执行-复核”闭环编排。

## What Changes
- 第一优先（护栏上线化）：
  - Skill Runtime V2：容器化执行后端（可选启用）+ 资源配额（内存/CPU/并发/超时）+ 出站策略细粒度（host+path+method）
  - 供应链治理 V1.5：动态 Skill 包签名校验扩展 + 依赖/漏洞扫描摘要 + 发布门槛与审计对齐
- 第二优先（模型生态）：
  - Provider 适配扩展：在现有 mock/openai 之外新增至少一个 provider 适配器（并保持同一契约/审计/限流/预算）
  - 路由/降级产品化：引入可配置的“路由策略对象”，并提供治理查询/变更入口
  - 配额/预算：引入 token/request 的硬/软预算（tenant/space/purpose 维度）并可观测
- 第三优先（编排闭环）：
  - 角色化闭环：Planner/Guard/Retriever/Executor 的最小闭环协议与状态机
  - 计划产物与证据引用标准化：plan/artifacts/evidenceRefs/digests 的结构与存储
  - 失败归类与重规划：统一 failure taxonomy 与可控重试/降级/重规划策略

## Impact
- Affected specs:
  - Skill Runtime（对照 架构-13 的 V2/V3 方向）
  - Model Gateway（对照 架构-09 的 provider/路由/配额/预算）
  - 多智能体协作与编排（对照 架构-18 的角色/证据/闭环）
- Affected code:
  - Worker：skill sandbox/runtime 适配层、容器执行器、资源/出站策略 enforcement、供应链扫描与审计摘要
  - API：模型 provider 适配、路由策略与预算治理 API、编排闭环 API（如新增）与审计字段对齐
  - DB：路由策略/预算/扫描结果（仅摘要）等表；必要时扩展现有 tool/networkPolicy 表达
  - Web：可选新增治理页/只读视图（路由策略、预算命中、执行失败分类、证据引用）

## ADDED Requirements

### Requirement: Skill Runtime 容器化执行（V2）
系统 SHALL 支持 Skill 执行的两种 runtime backend，并可按环境或治理配置选择：
- `process`：沿用现有子进程沙箱执行
- `container`：以容器隔离执行（默认更严格的资源与出站策略）

约束：
- 任何 backend 都 MUST 继承统一的执行语义：`toolRef`、`policySnapshotRef`、`idempotencyKey`、`limits`、`networkPolicy`、`outputDigest`、审计串联（traceId/runId/stepId）
- `container` backend MUST 默认拒绝出站；仅允许显式 networkPolicy 放行
- 运行时选择 MUST 可审计（outputDigest 标识 backend 与限制快照）

#### Scenario: 容器 backend 执行成功
- **WHEN** 目标工具配置为 container backend 且环境可用
- **THEN** 在容器内完成执行并返回 output
- **AND** 审计/step outputDigest 含 backend=container 与资源/出站摘要

#### Scenario: 容器不可用自动降级（可配置）
- **WHEN** backend=container 但容器运行时不可用
- **THEN** 若 policy 允许降级则回退到 process 执行并标注 degraded
- **AND** 若 policy 不允许降级则拒绝执行并返回可解释错误

### Requirement: Skill Runtime 资源配额（V2）
系统 SHALL 在执行前对每次工具调用强制资源配额：
- 最小集合：`timeoutMs`、`maxConcurrency`、`memoryMb`、`cpuMs`（或等价 CPU 限制表达）
- `process` backend：
  - MUST 强制 timeoutMs 与 maxConcurrency
  - SHOULD 通过运行参数限制内存（例如 Node 内存上限）并在超限时分类为 `resource_exhausted`
- `container` backend：
  - MUST 通过容器资源限制强制内存与 CPU

#### Scenario: 内存超限被终止
- **WHEN** 工具执行超过 memoryMb 限制
- **THEN** 执行被终止且错误分类为 resource_exhausted
- **AND** 审计/step outputDigest 仅包含摘要（不包含敏感 payload）

### Requirement: 出站策略细粒度（V2）
系统 SHALL 支持 networkPolicy 的细粒度规则，至少覆盖：
- host 精确匹配
- path 前缀匹配（可选）
- method 集合限制（GET/POST/PUT/DELETE 等）

兼容性：
- 现有 `allowedDomains: string[]` MUST 继续支持，等价于允许该 host 的所有 path/method

#### Scenario: 方法不在白名单被拒绝
- **WHEN** host/path 匹配但 method 不在允许集合内
- **THEN** 拒绝执行并分类为 policy_violation
- **AND** egressSummary 仅记录 host/method/allowed=false 与拒绝原因摘要

### Requirement: 供应链治理（签名 + 依赖扫描摘要）（V1.5）
系统 SHALL 在动态 Skill 包的发布/启用链路中引入供应链治理门槛：
- 签名校验：
  - MUST 校验包的签名与摘要（基于 depsDigest 或等价摘要）
  - MUST 支持受信公钥集合配置
- 依赖扫描摘要：
  - SHALL 对包依赖生成 scanSummary（仅摘要：包名、版本、严重级别计数、扫描时间、扫描器版本）
  - 支持治理门槛：当存在高/严重级别漏洞时默认拒绝发布（可配置为告警但放行）
- 审计对齐：
  - 发布/拒绝 MUST 写审计，并包含签名校验结果与 scanSummary

#### Scenario: 高危漏洞导致发布被拒绝
- **WHEN** 扫描结果包含严重级别漏洞且治理门槛为 deny
- **THEN** 发布被拒绝，返回可解释错误码
- **AND** 审计仅记录 scanSummary，不记录完整依赖树或漏洞细节原文

### Requirement: Model Gateway Provider 适配扩展（V2）
系统 SHALL 在保持现有模型调用契约不变的前提下，新增至少一个 provider 适配器：
- adapter MUST 复用 Secrets/Connector 托管与出站治理
- adapter MUST 复用 attempts/routingDecision/usageEvent 的审计与归集结构
- 对未支持 provider 的请求 MUST 返回一致的可解释错误（不以静默 skipped 作为最终结果）

#### Scenario: 新 provider 调用成功
- **WHEN** 绑定的新 provider 可用且请求合法
- **THEN** 返回 outputText 与 usage 摘要
- **AND** 写入 usage event 与审计 attempts

### Requirement: 路由/降级策略产品化（V2）
系统 SHALL 提供“路由策略对象”用于可配置路由与降级：
- 最小字段：
  - scope（tenant/space）、purpose、candidateModelRefs（有序列表）、fallbackPolicy（如：仅对 upstream_error/timeout 降级）
  - 生效状态与版本（支持灰度/回滚可选）
- `POST /models/chat` SHALL 优先使用命中的路由策略；未命中则使用默认策略
- 变更入口 MUST 受治理权限控制并写审计

### Requirement: 模型配额/预算（V2）
系统 SHALL 支持对模型调用施加预算：
- 维度：tenant/space/purpose（最小集合），可扩展到 user/toolRef
- 形式：
  - request 预算（例如 每分钟/每天请求数）
  - token 预算（例如 每日/每月 totalTokens 上限）
- 行为：
  - 软预算：超限时降级到更低成本候选或返回告警摘要
  - 硬预算：超限时拒绝并返回可解释错误码
- 可观测：
  - MUST 提供治理只读查询接口（聚合输出），并与审计 traceId 可串联

### Requirement: 编排闭环（Planner/Guard/Retriever/Executor）（V2）
系统 SHALL 提供最小闭环编排协议，使一次用户目标可被表示为可回放的计划与步骤：
- Planner：
  - 生成 plan（steps/guards/expectedArtifacts）并写入 taskState（或等价存储）
- Retriever：
  - 仅调用 `knowledge.search`/`memory.read` 等只读工具，产出 evidenceRefs（引用 + 摘要）
- Guard：
  - 对高风险步骤给出 allow/deny 与 reasonSummary（只摘要），并强制审批/确认门槛（如 approvalRequired）
- Executor：
  - 仅通过受控工具执行路径触发执行（如 orchestrator.execute / workflow step）
  - 负责 idempotencyKey 的生成/复用策略

失败与重规划：
- 系统 MUST 将失败归类为固定 taxonomy（至少：validation_error/policy_violation/upstream_error/timeout/resource_exhausted/internal_error）
- 允许在受控条件下触发 replan（例如：upstream_error/timeout 可重试或换候选；policy_violation 直接终止）

#### Scenario: 检索→计划→执行→复核闭环
- **WHEN** 用户发起目标，Planner 生成计划且 Retriever 提供证据摘要
- **THEN** Executor 执行步骤并产出结果摘要
- **AND** Guard 对高风险步骤要求审批或拒绝并可审计
- **AND** taskState/agent messages 可回放关键决策轨迹（仅摘要与引用）

## MODIFIED Requirements

### Requirement: networkPolicy 表达兼容升级（兼容）
系统 SHALL 在保持现有 `allowedDomains` 兼容的前提下扩展 networkPolicy：
- 新字段（示例级）：`rules: [{ host, pathPrefix?, methods? }]`
- 执行侧强制按 V2 规则评估；若仅提供 allowedDomains，则走兼容逻辑

### Requirement: Model Gateway 未实现 provider 的行为（兼容）
系统 SHALL 将“未实现 provider”从 attempts 的中间状态升级为一致的最终错误语义：
- 若所有候选均不可用或 provider 未实现，响应 MUST 为错误（而非静默成功/空结果）
- attempts 中仍可保留 `status=skipped, errorCode=PROVIDER_NOT_IMPLEMENTED` 作为诊断摘要

## REMOVED Requirements
（无）

