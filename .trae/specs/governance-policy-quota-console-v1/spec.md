# 治理控制台：路由策略与配额并发 V1 Spec

## Why
《架构设计.md》要求在治理模式下，Console 治理入口需要可视化并可管理“模型网关路由策略、速率/配额、并发上限”等关键治理参数。目前系统仅具备最小路由与 tenant RPM 限流（环境变量 + 代码内策略），缺少可审计、可回滚（通过变更集）且可在治理台操作的配置面。

## What Changes
- 新增治理台页面：
  - 路由策略：展示并编辑“按 purpose 的模型选择与 fallback 链路”
  - 配额与并发：展示并编辑模型调用 RPM（按 tenant/space）与工具执行默认 maxConcurrency（按 toolRef）
- 新增治理 API（读写均写审计，写操作要求治理权限）：
  - 路由策略 CRUD（V1：list + upsert + disable）
  - 配额并发配置读取与更新（V1：RPM 与 toolRef maxConcurrency）
- 新增持久化配置存储（DB）以替代“仅环境变量”配置；配置变更可通过“变更集”方式发布（V1 可先直写配置表，后续与变更集关联）
- **BREAKING（行为）**：`/models/chat` 的模型选择从“第一条 binding”升级为“按 purpose 的 routing policy（若存在）”，未配置时回退到现有行为

## Impact
- Affected specs:
  - 模型网关（路由/限流/配额）
  - 治理控制面（治理台可见、可审计变更）
  - 审计域（新增治理配置变更事件摘要）
- Affected code:
  - API：`apps/api/src/routes/models.ts`（读取 routing policy 与 rpm 配置）
  - API：新增 `apps/api/src/routes/governanceModelGateway.ts`（或扩展现有 governance routes）
  - DB：新增迁移表（routing_policies / quota_limits / tool_limits）
  - Web：新增 `/gov/routing` 与 `/gov/quotas` 页面（治理模式可见）

## ADDED Requirements
### Requirement: 治理台可管理模型路由策略
系统 SHALL 提供治理台页面与 API 来管理路由策略：
- 以 `purpose` 为主键（例如：`plan`/`tool_params`/`summarize`/`test`）
- 每条策略包含：`primaryModelRef`、`fallbackModelRefs[]`、`enabled`
- 展示当前有效策略列表与最后更新时间
- 支持对某 purpose 执行 upsert 与 disable

#### Scenario: 管理者更新路由策略
- **WHEN** 管理者在治理台提交某 purpose 的路由策略变更
- **THEN** 系统写入配置并返回最新策略
- **AND** 写审计（resourceType=governance, action=model_routing.update），不包含密钥与提示词原文

### Requirement: `/models/chat` 使用路由策略（V1）
系统 SHALL 在处理 `/models/chat` 请求时：
- 优先使用请求体 `purpose` 匹配的 routing policy（若 enabled）
- 其次使用请求体显式 `modelRef`（若提供）
- 再回退到当前 scope 的默认 binding（现有行为）
- 当 primary 失败且 fallback 配置存在时，按顺序尝试 fallback（V1 仅对“上游失败/超时”触发）

#### Scenario: 路由策略生效
- **WHEN** 用户以 purpose 调用 `/models/chat` 且存在 enabled 的 routing policy
- **THEN** `routingDecision` 指明命中的 policy 与最终 modelRef
- **AND** 审计记录包含 routingDecision 摘要与错误分类（如发生 fallback）

### Requirement: 治理台可管理 RPM 与工具并发上限（V1）
系统 SHALL 提供治理台页面与 API 来管理：
- 模型调用 RPM：按 scope（tenant/space）配置 `modelChatRpm`
- 工具执行默认并发：按 `toolRef` 配置 `defaultMaxConcurrency`

#### Scenario: 更新 RPM 与并发
- **WHEN** 管理者在治理台更新 RPM 或 toolRef 的并发上限
- **THEN** 变更立即生效（V1），并写审计（resourceType=governance, action=limits.update）

## MODIFIED Requirements
### Requirement: 限流来源升级为配置优先
系统 SHALL 在 `/models/chat` 的限流计算中优先读取 DB 配置（若存在），否则回退到环境变量默认值。

## REMOVED Requirements
无

