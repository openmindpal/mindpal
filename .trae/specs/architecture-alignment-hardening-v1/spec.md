# 架构对齐加固 V1 Spec

## Why
当前实现已覆盖“统一请求链路/契约化扩展/审计/工作流/治理”等主干，但仍存在若干与《架构设计.md》不变式不一致或未闭环的点，需要集中加固以避免在非开发环境下产生旁路与失控面。

## What Changes
- Web 端移除硬编码鉴权（`Bearer admin`），改为显式 Token 管理与校验流程
- Skill Runtime：在生产环境默认拒绝“非隔离”的动态 Skill（artifact 代码）执行，并增加可审计的拦截原因
- Skill Runtime：为动态 Skill 增加最小静态安全检查（manifest 与入口代码的禁止项扫描），减少明显旁路能力
- 安全配置：生产环境启动时强制要求关键密钥配置（例如 API_MASTER_KEY），禁止 dev fallback
- Knowledge：提升检索排序与可解释性（不引入新外部依赖的前提下增强召回/排序策略），保持 evidence/证据链输出与审计对齐

## Impact
- Affected specs:
  - 交互平面（Web/AuthN 体验）
  - Skill 运行时（隔离/最小权限/出站治理）
  - 安全中枢（默认安全配置）
  - 知识层（检索质量与证据链）
- Affected code:
  - Web：`apps/web/src/lib/api.ts` 与登录/设置相关页面
  - API：鉴权相关（仅对接/校验，不新增旁路）
  - Worker：`apps/worker/src/workflow/processor.ts` 动态 Skill 执行路径
  - Knowledge：`apps/api/src/modules/knowledge/*` 与对应 routes

## ADDED Requirements

### Requirement: Web Token 管理（替代硬编码鉴权）
系统 SHALL 提供一种明确的方式让用户在 Web 端配置并使用访问 Token（开发态与生产态均不允许在代码中硬编码默认 token）。

#### Scenario: Token 缺失
- **WHEN** 用户访问任意需要调用 API 的页面且本地未配置 token
- **THEN** 页面提示需要配置 token（或跳转到 token 配置页）
- **AND** 不发起携带默认 token 的 API 请求

#### Scenario: Token 配置成功
- **WHEN** 用户在 Web 配置 token
- **THEN** 后续 API 调用使用该 token 作为 Authorization
- **AND** 用户可在设置页清除 token

#### Scenario: Token 无效
- **WHEN** Web 使用 token 调用 API 返回 401
- **THEN** Web 清晰提示鉴权失败并引导重新配置 token

### Requirement: 生产环境默认拒绝非隔离动态 Skill 执行
系统 SHALL 在生产环境（`NODE_ENV=production` 或等价判定）默认拒绝执行 `artifact_ref` 指向的动态 Skill 代码，除非明确启用“允许非隔离执行”的运维配置。

#### Scenario: 生产环境未启用非隔离执行
- **WHEN** worker 收到需要执行动态 Skill（存在 `artifactRef`）的 step
- **THEN** step 以 `policy_violation` 失败
- **AND** 审计与 outputDigest 中记录拒绝原因（不包含敏感内容）

#### Scenario: 明确启用非隔离执行（受控例外）
- **WHEN** 运维显式启用非隔离动态 Skill 执行
- **THEN** worker 允许执行动态 Skill
- **AND** 仍强制执行：artifact 目录白名单、depsDigest 校验、networkPolicy 仅对平台内置出站工具生效（并在文档中明确“非隔离模式风险”）

### Requirement: 动态 Skill 的最小静态安全检查
系统 SHALL 在加载动态 Skill 前对其 manifest 与入口代码做最小静态检查，以阻断明显的旁路能力。

#### Scenario: 命中禁止项
- **WHEN** 动态 Skill manifest/入口代码命中禁止项（例如 child_process/net/http/https/tls/dns 等，具体列表在实现中常量化）
- **THEN** worker 拒绝执行并标记 `policy_violation`
- **AND** 审计记录命中规则摘要（仅模块名/规则名，不记录源码）

### Requirement: 生产环境禁止关键密钥 dev fallback
系统 SHALL 在生产环境启动时拒绝使用默认/占位 master key，并以明确错误终止启动或拒绝相关敏感能力。

#### Scenario: master key 缺失
- **WHEN** 生产环境未配置 `API_MASTER_KEY`
- **THEN** 服务启动失败或相关能力返回明确错误（实现选择其一，但必须避免静默回退到 dev key）

### Requirement: Knowledge 检索排序增强（无新增外部依赖）
系统 SHALL 在不引入新外部依赖的前提下提升知识检索的排序质量与可解释性，并保持证据链字段稳定。

#### Scenario: 检索返回结果
- **WHEN** 用户执行 knowledge.search
- **THEN** 返回 evidence[] 仍包含 sourceRef/snippet/location/retrievalLogId
- **AND** RetrievalLog 记录候选数与 citedRefs
- **AND** 新增（或扩展）排序摘要字段（例如 rankReason/scoreDigest）以便审计与回放对齐

## MODIFIED Requirements

### Requirement: 客户端上下文不可被信任（Web 端实现约束）
系统 SHALL 不在 Web 代码中内置任何默认身份或默认 token；所有 token 必须来自显式用户输入或受控配置注入（开发态也必须可见且可清除）。

### Requirement: 扩展只走契约（动态 Skill 的约束）
系统 SHALL 将动态 Skill 视为高风险扩展：在具备可证明隔离前，生产环境默认拒绝其执行；允许例外必须通过显式配置开启并可审计。

## REMOVED Requirements
无

