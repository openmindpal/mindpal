# 平台关键缺口补齐与加固（V1）Spec

## Why
当前系统核心不变式（统一链路、RBAC/Policy、审计、DLP、工作流审批）已具备，但在“可上线、可运营、可扩展”的关键维度仍存在缺口：模型网关生产化、Skill 运行时生产隔离与供应链治理、可观测性/运维工具链，以及更丰富的 ABAC 行级表达能力。

## What Changes
- 模型网关生产化：多候选路由与故障降级、轻量熔断、使用量/成本归集与治理查询
- Skill 运行时加固：生产可控启用门槛、包信任策略（签名/来源约束）、隔离执行（子进程沙箱）与审计摘要对齐
- 可观测性增强：补齐 worker/队列/模型/工具关键指标、健康检查与诊断信息输出
- 运维/管理工具链：新增最小管理 CLI（基于现有 API）与常用运维动作的只读/幂等封装
- ABAC 行级表达增强：在现有 owner_only 基础上扩展有限 DSL（OR 语义）并贯穿数据面/工具执行链路

## Impact
- Affected specs:
  - 模型网关（路由/降级/限流/审计/成本归集）
  - Skill Runtime（隔离执行/供应链治理/出站治理）
  - 授权模型（RBAC → ABAC 的行级表达增强）
  - 可观测性与质量保障（metrics/health/diagnostics）
  - 运维与治理控制面（admin 工具链）
- Affected code:
  - API：/models/*、/governance/*、/metrics、/healthz、/diagnostics（新增或扩展）
  - Worker：工具/模型执行路径的隔离与统计、队列指标暴露
  - DB：新增模型调用用量归集表、扩展 rowFilters DSL 存储结构（兼容旧值）
  - Web：可选新增治理页查看模型用量/熔断状态（最小可读）

## ADDED Requirements

### Requirement: Model Gateway 生产化路由与降级（V1）
系统 SHALL 在 `POST /models/chat` 中支持“多候选绑定 + 故障降级”：
- 输入 `constraints.candidates`（可选）：按优先级给出候选 `modelRef` 列表（或允许 purpose → 默认候选集合）
- 路由策略：按候选顺序尝试，遇到可重试的 upstream_error/timeout 自动切换下一个候选
- 失败摘要：响应与审计 outputDigest 中包含 attempts[]（modelRef、status、errorCategory 摘要），不包含敏感内容

#### Scenario: 首选失败自动降级
- **WHEN** 首选候选提供方超时或返回上游错误
- **THEN** 系统自动尝试下一个候选并返回成功结果
- **AND** 审计包含 attempts 摘要与最终 routingDecision

### Requirement: Model Gateway 轻量熔断（V1）
系统 SHALL 对每个（tenantId, scope, modelRef）维护轻量熔断状态：
- 触发条件（最小规则）：在窗口内连续 N 次 upstream_error/timeout 进入 open 状态，持续 T 秒
- open 状态：直接拒绝该候选并记录在 attempts（status=skipped, reason=circuit_open），继续尝试后续候选
- 状态存储：允许使用 Redis（与现有限流同类）或 DB（可选）

#### Scenario: 熔断跳过候选
- **WHEN** 某候选处于 open 状态
- **THEN** 系统不发起上游请求，直接跳过并尝试下一个候选

### Requirement: Model Gateway 用量/成本归集（V1）
系统 SHALL 将每次模型调用的用量摘要写入可查询的归集数据：
- 至少记录：tenantId、spaceId、subjectId（可为空）、purpose、provider、modelRef、promptTokens/completionTokens/totalTokens（可为空）、latencyMs、result（success/denied/error）、timestamp
- 不记录：明文 prompt、明文输出、密钥、完整上游响应
- 提供治理查询接口（只读）：`GET /governance/models/usage` 支持按时间范围/spaceId/purpose/modelRef 聚合输出

#### Scenario: 查询过去 24 小时用量
- **WHEN** 具备治理权限的用户查询 `/governance/models/usage?range=24h`
- **THEN** 返回聚合后的计数与 token 摘要

### Requirement: Skill 包信任策略（V1）
系统 SHALL 支持对动态 Skill 包实施信任策略：
- 支持在 `manifest.json` 中携带 `signature`（可选）与 `signedDigest`（或等价结构）
- 生产环境默认：未命中信任策略的包拒绝执行（policy_violation）
- 信任策略最小形态（可配置）：允许的 artifact roots + 允许的签名公钥集合（或等价信任锚）

#### Scenario: 未签名包在生产环境被拒绝
- **WHEN** 生产环境执行未签名且不在信任列表内的动态 Skill
- **THEN** 拒绝并写审计（仅规则摘要，不含包内容）

### Requirement: Skill 隔离执行（子进程沙箱，V1）
系统 SHALL 将动态 Skill 执行迁移到隔离进程：
- Worker 主进程与 Skill 子进程通过受控 IPC 传递 input/output 摘要
- 子进程启动参数最小化（受控 env、禁用不必要调试能力）
- 超时/并发/出站治理语义与现有 MVP 保持一致

#### Scenario: 子进程超时被终止
- **WHEN** Skill 执行超过 timeoutMs
- **THEN** 子进程被终止，结果分类为 timeout，并写审计摘要

### Requirement: 可观测性增强（V2 聚焦）
系统 SHALL 补齐以下指标与健康检查：
- `/metrics` 增加：worker tick 状态、workflow queue 深度/处理耗时、tool.execute 与 model.invoke 的成功/失败/超时计数与延迟分布
- `/healthz`（只读）：返回 api/worker 关键依赖连通性（DB/Redis）与版本信息（不含敏感配置）
- `/diagnostics`（只读，需权限）：返回可用于排障的最小摘要（队列堆积、最近错误计数、熔断 open 数）

#### Scenario: 运维查看健康状态
- **WHEN** 运维访问 `/healthz`
- **THEN** 返回 200 且包含 db/redis status 与版本号

### Requirement: 运维/管理 CLI（V1）
系统 SHALL 提供一个最小管理 CLI（单独 app 或包）用于调用现有 API：
- 仅包含只读/幂等命令（V1）：查看队列/worker 状态、验证审计 hashchain、导出用量摘要、查询 changeset 状态
- CLI 使用 API token（不在命令行输出敏感信息），输出支持 traceId

#### Scenario: 验证审计链完整性
- **WHEN** 管理员运行 `audit verify --tenant <id> --range <...>`
- **THEN** CLI 输出验证结果摘要（通过/失败与失败位置），不输出敏感事件明文

### Requirement: ABAC 行级表达增强（Row Filters V2）
系统 SHALL 在现有 `rowFilters` 能力上扩展有限 DSL，并以 OR 语义合并命中权限：
- 新增支持的过滤类型（最小集合）：
  - `owner_only`（沿用）
  - `payload_field_eq_subject`：payload 中某字段等于当前 subjectId（字段名必须存在于 Effective Schema 且类型为 string/uuid）
  - `payload_field_eq_literal`：payload 中某字段等于给定字面量（仅允许 string/number/boolean）
- 合并规则（V2）：对命中的 rowFilters 取 OR；若任一命中权限 rowFilters 为空/未设置，则视为无行级限制
- 强制执行范围：entity get/list/query/export + 工具执行链路中对 entity 数据访问

#### Scenario: payload 字段等于 subjectId 的可见性
- **WHEN** 用户拥有 `entity.read` 且 rowFilters=payload_field_eq_subject(field="assigneeId")
- **THEN** 用户仅能读到 assigneeId 等于自身的记录

## MODIFIED Requirements

### Requirement: RBAC/Policy Snapshot 返回结构扩展（兼容）
系统 SHALL 在不破坏现有结构的前提下扩展 rowFilters 表达：
- 旧值 `{"kind":"owner_only"}` 必须继续兼容
- 新增 rowFilters DSL 必须可被 policy snapshot 记录与回放

## REMOVED Requirements
（无）

