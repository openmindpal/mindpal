# UI 页面配置纳入治理变更集（ChangeSet）V1 Spec

## Why
根据 `架构-01-交互平面-UI与页面配置` 与 `架构-16-治理控制面`：租户/空间级页面配置属于治理对象，必须与其他治理变更（Schema/Tool/ModelPolicy 等）走同一条 changeset 流程（preflight→提交→审批→发布→回滚），并产出可审计、可回滚的变更摘要，避免“页面发布”成为绕开治理的旁路入口。

当前页面配置已具备 draft/released 与发布/回滚能力，但未纳入 changeset 统一治理，缺少：
- 与审批门槛一致的风险计算（含写动作/高风险 toolRef）
- changeset preflight 统一预检计划与回滚预览
- changeset rollback 统一恢复到发布前状态

## What Changes
- 新增 changeset item kind（UI 配置治理动作）
  - `ui.page.publish`：发布某 pageName 的草稿为 released 新版本（scope 为 changeset scope）
  - `ui.page.rollback`：将某 pageName 回滚到上一 released 版本（scope 为 changeset scope）
- changeset preflight 增加 UI 配置摘要输出（只输出摘要/计数/摘要哈希，不输出完整 UI JSON）
- changeset release/apply 执行 UI 配置发布/回滚，并记录 rollbackData 以支持一键回滚
- changeset 风险分级与审批门槛：
  - 若页面包含 ActionBinding 或引用高风险工具，riskLevel 至少为 high，requiredApprovals 至少为 2
- **BREAKING（推荐）**：对外的页面发布接口（如存在）应被视为治理入口的兼容层，长远以 changeset 为唯一发布路径（V1 可先保留并提示 deprecated）

## Impact
- Affected specs:
  - 交互平面（UI）与页面配置
  - 治理控制面（changeset/preflight/release/rollback）
  - 审计域（治理动作审计摘要）
- Affected code:
  - apps/api/src/modules/governance/changeSetRepo.ts（新增 kind、preflight、release/rollback apply）
  - apps/api/src/routes/governance.ts（changeset items API 扩展 payload 校验）
  - apps/api/src/modules/uiConfig/pageRepo.ts（复用 publish/rollback 能力）
  - apps/web（若需要：治理控制台里新增 UI 配置变更项展示，V1 可不做）

## ADDED Requirements

### Requirement: ChangeSetUiPagePublishV1
系统 SHALL 支持通过 changeset 发布 UI 页面配置：
- changeset item：`kind="ui.page.publish"`
- payload SHALL 包含：
  - `pageName`（字符串，min=1）
- release 行为：
  - 从 scope（tenant/space）下的 page draft 读取并执行发布
  - 若 draft 不存在或非法，release MUST 失败并返回稳定错误码（例如 `UI_CONFIG_DENIED`/`CHANGESET_INVALID_ITEM` 等，复用现有错误体系）
- rollbackData：
  - MUST 记录发布前的“上一 released 版本引用信息”（例如 fromVersion/toVersion 或 prevReleasedRef）
  - changeset rollback MUST 将页面配置恢复为发布前状态

#### Scenario: 通过 changeset 发布页面配置
- **WHEN** 创建 changeset（scope=space/tenant）并添加 `ui.page.publish`，提交→审批→release
- **THEN** 该 scope 下页面配置产生新的 released 版本
- **AND** Web/UI 获取导航/页面时可见该 released 版本

### Requirement: ChangeSetUiPageRollbackV1
系统 SHALL 支持通过 changeset 回滚 UI 页面配置：
- changeset item：`kind="ui.page.rollback"`
- payload：`{ pageName }`
- release 行为：将页面回到上一 released 版本
- 若不存在上一版本：返回稳定错误码（例如 `UI_CONFIG_NO_PREVIOUS_VERSION`）

#### Scenario: changeset 回滚页面配置
- **WHEN** release 应用 `ui.page.rollback`
- **THEN** Web/UI 获取导航/页面时返回上一 released 版本

### Requirement: ChangeSetUiPreflightDigestV1
系统 SHALL 在 changeset preflight 返回 UI 配置影响面摘要：
- 输出 SHALL 至少包含：
  - `pageName`
  - `scopeType/scopeId`
  - `currentReleasedVersion`（若不存在则为 null）
  - `actionBindingsCount`
  - `dataBindingsCount`
  - `referencedToolRefsDigest`（可用 sha256 摘要，不输出全量 toolRef 列表也可）
  - `riskHints`（例如：containsWriteActions/approvalRequiredToolsCount）
- preflight MUST 为只读，不改变 draft/released 状态
- preflight MUST NOT 输出完整 UI JSON（如 page.ui 或大块 layout 数据）

### Requirement: ChangeSetUiRiskGateV1
系统 SHALL 基于页面配置内容计算 changeset risk：
- 若页面存在 ActionBinding（或引用 approvalRequired/risk=high 的 toolRef），riskLevel MUST 为 high 且 requiredApprovals MUST ≥ 2
- 否则可按低/中风险策略（V1 可直接统一为 high 以简化）

## MODIFIED Requirements

### Requirement: GovernanceChangeSetConsistencyV1
系统 SHALL 将“页面配置发布/回滚”纳入与 Schema/Tool 同样的治理链路，并保证：
- 预检输出可解释摘要
- 发布可回滚
- 全过程写审计（仅摘要）

## REMOVED Requirements
（无）

