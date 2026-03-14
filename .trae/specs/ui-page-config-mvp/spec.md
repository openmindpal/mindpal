# 页面配置与导航发布（UI Plane MVP）Spec

## Why
当前 Web/UI 仍以“硬编码导航 + 固定页面”为主，与《架构设计.md》要求的“页面配置（租户/空间级）版本化治理、受控数据绑定、受控动作映射”不一致，需要补齐可配置与可治理的 UI 平面最小闭环。

## What Changes
- 新增 PageTemplate（租户/空间级）与版本化发布：draft/released + version
- 新增 Navigation（租户/空间级）：从已发布 PageTemplate 生成可见导航（支持 i18n）
- 新增受控绑定：
  - DataBinding 仅允许绑定到平台 API（例如 entities 查询、schema/effective schema）
  - ActionBinding 仅允许映射到 Tool/Workflow（引用 toolRef，按风险与审批要求走队列）
- 新增回滚能力：回到上一个 released 版本（MVP 可按“重新发布旧版本”实现）
- Web/UI 改为从 API 获取导航与页面定义，并按白名单页面类型渲染

## Impact
- Affected specs:
  - 交互平面（UI）与页面配置
  - BFF/API 与统一请求链路
  - 工具注册表与受控执行（ActionBinding）
  - 审计域（配置发布/回滚审计）
- Affected code:
  - API：新增 UI 配置模块与 /ui/* 路由
  - DB：新增 page_templates/page_template_versions（或等价）迁移
  - Web：主页导航与实体页面入口由配置驱动

## ADDED Requirements

### Requirement: PageTemplate（租户/空间级页面配置，版本化）
系统 SHALL 支持租户/空间级页面配置对象 PageTemplate 的定义与版本管理，并提供发布（released）机制。

#### Scenario: 发布页面配置
- **WHEN** 管理者发布某页面配置新版本
- **THEN** 系统生成新的 released version
- **AND** 发布版本对 Web/UI 可见且可被导航引用
- **AND** 全过程写入审计（resourceType=ui_config, action=publish）

### Requirement: 导航生成（仅基于已发布页面）
系统 SHALL 仅从已发布的 PageTemplate 生成/返回导航集合，并按语言偏好返回 i18n 标题。

#### Scenario: 未发布页面不可见
- **WHEN** 页面配置仍为 draft
- **THEN** Web/UI 获取导航时不可见该页面

### Requirement: 受控 DataBinding（仅允许平台 API）
系统 SHALL 将页面的数据来源限定为平台 API，并以 DataBinding 声明式表达。

#### Scenario: 数据绑定被约束
- **WHEN** 页面配置声明数据绑定
- **THEN** 绑定目标必须在允许清单内（例如 /entities/:entity、/schemas/:entity/effective）
- **AND** 实际数据请求仍经过统一请求链路与字段裁剪

### Requirement: 受控 ActionBinding（仅允许 Tool/Workflow）
系统 SHALL 将页面的写动作限定为 Tool/Workflow 调用，并以 ActionBinding 声明式表达；ActionBinding 引用的 toolRef 必须是已发布版本。

#### Scenario: 动作绑定引用工具版本
- **WHEN** 页面配置绑定某动作到 toolRef
- **THEN** 系统校验 toolRef 存在且 status=released
- **AND** 若工具为高风险或 approvalRequired，则执行必须进入队列并可回执查询

### Requirement: 页面类型白名单（MVP）
系统 SHALL 仅支持白名单页面类型的渲染，禁止任意组件树与脚本注入。

#### Scenario: 非法页面类型
- **WHEN** PageTemplate 声明未知/不允许的 pageType
- **THEN** 发布被拒绝并返回稳定 errorCode，同时写审计（result=denied）

## MODIFIED Requirements

### Requirement: Web/UI MVP（Schema 驱动通用页面）
Web/UI 的导航与页面入口 SHALL 由 API 返回的已发布 PageTemplate/Navigation 驱动，避免前端硬编码实体列表与入口。

## REMOVED Requirements
（无）

