# 架构-01 验收增强：openView 白名单 + 组件注册表治理 V1 Spec

## Why
当前 Web 会直接把编排返回的 `uiDirective(openView=page)` 渲染成可点击链接，存在“信任回执直接跳转”的旁路风险；同时组件注册表仍为静态 allowlist，缺少版本化治理能力与可回滚的变更记录。

## What Changes
- Web：对 `uiDirective.openView` 增加白名单/存在性校验与降级策略，避免直接跳转到未发布或无权限的页面/工作台。
- Web：补齐个人视图偏好（ViewPrefs）端到端回归：写入偏好 → 刷新渲染生效 → 删除偏好恢复默认。
- API：新增“UI 组件注册表（allowlist）”的版本化治理资源（draft/released/rollback），并在 PageTemplate 发布/保存校验中强制执行。
- API：为组件注册表治理新增审计动作（成功/拒绝/失败都入审计摘要）。

## Impact
- Affected specs:
  - 架构-01-交互平面-UI与页面配置（本条验收增强）
  - ui-page-config-mvp（PageTemplate 绑定/发布校验链路扩展）
  - enhance-page-template-experience-v1（Component Registry 概念延伸为可治理 allowlist）
  - add-chat-console-ui-v1（Chat uiDirective 渲染行为收敛）
- Affected code:
  - Web：`apps/web/src/app/chat/ui.tsx`（uiDirective 渲染与跳转）
  - Web：`apps/web/scripts/e2e-console-mode.mjs`（回归覆盖扩展）
  - API：`apps/api/src/routes/ui.ts`（validateDraft 扩展）
  - API：`apps/api/src/modules/uiConfig/componentRegistry.ts`（代码内注册表继续作为“组件实现映射”来源）
  - API：新增 `apps/api/src/routes/uiComponentRegistry.ts`（或并入现有治理路由，按代码风格确定）
  - DB：新增 migration（UI 组件注册表版本表）

## ADDED Requirements

### Requirement: UiDirectiveOpenViewWhitelistV1
系统 SHALL 在 Web 端对 `uiDirective.openView` 的“可跳转目标”执行白名单/存在性校验，并在不满足时降级为纯展示（不提供可点击跳转）。

约束：
- Web 不得在渲染时直接生成可点击跳转链接到目标页（即不“信任回执直接跳转”）。
- 校验必须基于平台受控 API 的返回结果（例如 PageTemplate 必须已发布且当前主体有权限读取）。

#### Scenario: openView=page 校验通过并跳转
- **WHEN** 编排返回 `uiDirective.openView="page"` 且 `viewParams.name` 指向某已发布 PageTemplate
- **AND** 当前主体对 `/ui/pages/:name` 具备读取权限且返回 `released != null`
- **THEN** Web 才允许用户执行跳转到 `/p/:name`

#### Scenario: openView=page 不存在或未发布时降级
- **WHEN** `openView="page"` 但 `/ui/pages/:name` 返回 `released == null` 或返回 403/404
- **THEN** Web 不渲染跳转入口（或显示“不可打开”的提示），仅保留 `uiDirective` 的只读展示

#### Scenario: openView=workbench 校验通过并跳转
- **WHEN** 编排返回 `uiDirective.openView="workbench"` 且 `viewParams.workbenchKey` 指向某已发布 workbench
- **AND** `/workbenches/:workbenchKey/effective` 返回 200
- **THEN** Web 才允许用户执行跳转到 `/w/:workbenchKey`

### Requirement: UiComponentRegistryGovernanceV1
系统 SHALL 提供“UI 组件 allowlist”的版本化治理资源，并在 PageTemplate 保存/发布校验中强制执行该 allowlist。

定义：
- “组件实现映射”仍以代码内 `componentRegistry.ts` 为唯一来源（不允许任意模块/URL 动态加载）。
- “可用组件 allowlist”由治理资源定义，决定在某 scope（tenant/space）下哪些 `componentId` 允许被 PageTemplate 引用。
- 若某 scope 未配置任何已发布 allowlist，系统 SHALL 默认允许所有代码内已注册组件（保持向后兼容）。

治理 API（最小集，具体路由可按现有风格落到 `routes/`）：
- `GET /governance/ui/component-registry`：返回该 scope 的最新 released 版本与允许的 `componentIds`（不返回组件实现代码/props 默认值等）。
- `PUT /governance/ui/component-registry/draft`：创建或更新 draft 版本（携带 `componentIds`）。
- `POST /governance/ui/component-registry/publish`：将 draft 发布为 released（生成新 version 或推进版本号）。
- `POST /governance/ui/component-registry/rollback`：回滚到上一 released 版本（若不存在则返回稳定错误码）。

校验规则：
- 任何 `componentIds` 必须是代码内已注册的 `componentId`，否则拒绝 draft 保存/发布（稳定错误码）。
- PageTemplate draft/release 校验时，若引用了不在 allowlist 中的 `componentId`，必须拒绝保存/发布（稳定错误码）。

#### Scenario: 发布 allowlist 并限制组件引用
- **WHEN** 管理员创建并发布 allowlist（仅允许 `EntityList.Table`）
- **THEN** 该 scope 下发布/保存引用 `EntityList.Cards` 的 PageTemplate 必须被拒绝

#### Scenario: allowlist 包含未知组件时拒绝
- **WHEN** allowlist 中包含 `componentId="EntityList.Unknown"`
- **THEN** API 拒绝 draft 保存/发布，并返回稳定错误码（例如 `UI_COMPONENT_REGISTRY_DENIED`）

#### Scenario: 回滚恢复上一版本
- **WHEN** 已发布版本从 V1（允许 A,B）升级到 V2（仅允许 A）
- **AND** 执行 rollback
- **THEN** active allowlist 恢复为 V1，PageTemplate 校验随之恢复

### Requirement: ViewPrefsE2ERegressionV1
系统 SHALL 提供覆盖 ViewPrefs 的端到端回归用例，验证偏好写入与渲染合并逻辑的正确性。

#### Scenario: 保存偏好 → 生效 → 重置恢复
- **WHEN** 通过 API `PUT /ui/pages/:name/view-prefs` 保存 list columns 偏好（例如仅保留 `title`）
- **THEN** 再次请求 `/p/:name` 的渲染结果应反映列变化（例如表头不再包含“内容”）
- **WHEN** 通过 API `DELETE /ui/pages/:name/view-prefs` 重置偏好
- **THEN** 再次请求 `/p/:name` 的渲染结果应恢复默认列集合

## MODIFIED Requirements

### Requirement: PageTemplateDraftValidationV1
现有 PageTemplate draft/save/publish 的校验 SHALL 增加对“治理 allowlist”的检查：
- 若当前 scope 存在已发布 UI 组件 allowlist，则 draft 中引用的 `componentId` 必须同时满足：
  - 在代码内 Component Registry 中存在
  - 在治理 allowlist 中被允许
- 若当前 scope 不存在已发布 allowlist，则仅要求 `componentId` 在代码内 Component Registry 中存在

## REMOVED Requirements
无
