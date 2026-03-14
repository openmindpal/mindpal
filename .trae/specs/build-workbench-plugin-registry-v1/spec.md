# 可插拔的专业工作台（Workbench Plugin）注册表与治理 V1 Spec

## Why
当前系统主要依赖 PageTemplate/UI 配置与少量固定页面来承载交互，尚缺少“可插拔的专业工作台”这一层能力：组件/工作台需白名单化、版本化发布、支持灰度与回滚，避免引入绕开统一链路的旁路 UI 执行面。

## What Changes
- 新增 **Workbench Plugin Registry**：可在租户/空间范围注册工作台插件（workbench）及其版本，版本引用 artifactRef 并保存 manifest 摘要。
- 新增 **Workbench Sandbox Host**（Web）：以受控宿主加载已发布工作台（V1 以 iframe sandbox 形态），工作台仅能通过受控消息桥访问数据与动作。
- 新增 **Workbench Capability Allowlist**：插件 manifest 声明允许的能力（数据绑定/动作映射/出站策略），API 在发布与运行时校验；默认拒绝。
- 新增 **版本化发布/灰度/回滚治理**：将 workbench 插件版本纳入治理变更集（changeset）执行发布、灰度与回滚，并输出只读 preflight 摘要。
- **不引入任意脚本执行旁路**：插件资产只允许来自已入库 artifactRef；运行时强制 CSP + iframe sandbox；插件不得直连数据库或绕过 API。

## Impact
- Affected specs:
  - 架构 01/交互平面（专业工作台插件化）
  - 架构 02/统一 API 请求链路（工作台访问数据/动作必须走 API）
  - 架构 16/治理控制面（发布/灰度/回滚）
  - 架构 12/安全中枢（出站与外发护栏）
- Affected code:
  - API：新增 `modules/workbenches/*`、`routes/workbenches.ts`；扩展 `modules/governance/*` 支持 workbench changeset item kind
  - Web：新增 workbench host 页面与桥接运行时（建议 `apps/web/src/app/w/[workbench]/page.tsx` + `apps/web/src/lib/workbenches/*`）
  - 存储：新增 workbench 插件与版本表（migration）

## ADDED Requirements

### Requirement: WorkbenchPluginRegistryV1
系统 SHALL 支持在 scope（tenant/space）下注册工作台插件与版本：
- 插件标识：`workbenchKey`（稳定字符串，scope 内唯一）
- 插件版本：`version`（递增整数或语义化版本字符串；V1 推荐递增整数以简化）
- 版本必须引用 `artifactRef`（由平台现有 artifacts 能力托管）
- 版本 SHALL 保存 `manifestJson`（结构化）与 `manifestDigest`（sha256）以用于审计与回放定位

#### Scenario: 创建插件与版本（草稿）
- **WHEN** 管理员在某 scope 下创建 `workbenchKey="ops.dashboard"` 并上传/绑定一个 artifactRef 作为版本草稿
- **THEN** 系统保存该版本为 `draft`，未发布前运行时不可见

### Requirement: WorkbenchPluginManifestContractV1
每个 workbench 插件版本 SHALL 具有 manifest 契约，至少包含：
- `apiVersion`（固定值，例如 `workbench.openslin/v1`）
- `workbenchKey`
- `entrypoint`（V1 仅支持 `type="iframe"`）
  - `assetPath`：指向 artifact 中的入口文件相对路径（例如 `index.html`）
- `capabilities`（白名单声明）：
  - `dataBindings`：允许的数据绑定类型与参数上限（例如仅允许 `entities.query/entities.get/schema.effective`，且限制 entityName 白名单或规则表达式）
  - `actionBindings`：允许的动作映射（仅允许映射到 Tool/Workflow；可限制 toolRef 前缀或显式 allowlist）
  - `egressPolicy`：插件允许的外发域名（V1 推荐默认 `[]`，即不允许插件直接网络出站）
- `ui`（可选）：展示名与描述（支持 i18n）

#### Scenario: 非法能力声明拒绝保存
- **WHEN** manifest 声明了未允许的数据绑定类型（例如试图声明 `sql.raw` 或任意 URL fetch）
- **THEN** API 拒绝保存该版本并返回稳定错误码（例如 `WORKBENCH_MANIFEST_DENIED`）

### Requirement: WorkbenchGovernedReleaseV1
workbench 插件版本发布 MUST 走治理链路（changeset），并支持回滚：
- 新增 changeset item kind：
  - `workbench.plugin.publish`：发布某 `workbenchKey` 的某个版本为 active
  - `workbench.plugin.rollback`：回滚某 `workbenchKey` 到上一 active 版本
- changeset preflight SHALL 输出只读摘要（不泄露插件资产内容）：
  - `workbenchKey`、`fromVersion`、`toVersion`
  - `manifestDigest`
  - `capabilitiesSummary`（计数/摘要哈希）
  - `riskHints`（是否包含写动作、是否引用高风险 toolRef 等）
- release SHALL 记录 rollbackData，以支持一键回滚恢复到发布前 active 状态

#### Scenario: 通过 changeset 发布工作台版本
- **WHEN** 创建 changeset 并添加 `workbench.plugin.publish`，提交→审批→release
- **THEN** 该 scope 下 `workbenchKey` 的 activeVersion 变更为目标版本
- **AND** Web 的 workbench host 可加载该版本

#### Scenario: 通过 changeset 回滚工作台版本
- **WHEN** release 应用 `workbench.plugin.rollback`
- **THEN** activeVersion 恢复为上一版本（若不存在则返回稳定错误码，例如 `WORKBENCH_NO_PREVIOUS_VERSION`）

### Requirement: WorkbenchCanaryV1
系统 SHALL 支持对 workbench 插件进行灰度发布（V1 最小形态）：
- canary 目标为同一 `workbenchKey` 的另一版本（`canaryVersion`）
- canary 生效范围（V1）：
  - 允许按 subject allowlist 灰度（显式用户列表）
  - 或按百分比灰度（可选，若实现则 MUST 以稳定 hash(subjectId) 决策）
- canary 配置 MUST 可被治理回滚，并写入审计摘要

#### Scenario: 灰度仅对指定用户生效
- **WHEN** 将 `workbenchKey` 的 canaryVersion 配置为新版本，并把某 subjectId 加入 canaryAllowlist
- **THEN** 该 subjectId 加载 workbench 时使用 canaryVersion，其他用户仍使用 activeVersion

### Requirement: WorkbenchSandboxHostV1
Web SHALL 以受控宿主加载 workbench 插件，并强制隔离与最小权限：
- 宿主路由：`/w/[workbenchKey]`（或等价路径）
- 加载方式：iframe sandbox（V1 固定）
  - sandbox 属性 MUST 禁止任意顶层导航与弹窗滥用（最小集）
  - CSP MUST 默认禁止插件直接出站（connect-src 'none' 或等价策略）
- 插件与宿主通过 postMessage 协议交互：
  - 宿主仅暴露受控能力（数据绑定读取、受控动作触发、导航请求等）
  - 宿主 MUST 在 API 侧执行 AuthN/AuthZ/Audit/DLP，不允许插件绕过

#### Scenario: 插件发起数据查询
- **WHEN** 插件向宿主发送 `entities.query` 请求消息
- **THEN** 宿主校验该请求符合 manifest capabilities 白名单
- **AND** 宿主调用平台 API 获取结果并返回给插件
- **AND** 若请求超出白名单，宿主返回拒绝错误且写入审计摘要（至少记录拒绝原因摘要）

### Requirement: WorkbenchAccessControlV1
系统 SHALL 支持对 workbench 的可见性与访问做权限控制：
- 至少提供 `workbench.view` 权限（或复用现有 RBAC permission 模型）控制访问宿主路由
- workbench 内部的数据读写仍以现有权限体系为准（权限不可被 workbench 扩大）

#### Scenario: 无权限访问被拒绝
- **WHEN** 无 `workbench.view` 权限的 subject 访问 `/w/ops.dashboard`
- **THEN** Web 显示 403 或等价错误页，API 审计记录拒绝摘要

## MODIFIED Requirements

### Requirement: UiAndWorkbenchNoBypassV1
系统对 PageTemplate/UI 配置与 Workbench 插件 SHALL 一致遵守平台不变式：
- 任何数据读取/写入 MUST 走统一 API 链路
- 任何高风险动作 MUST 可被治理（审批/灰度/回滚）并进入审计（摘要）

## REMOVED Requirements
无
