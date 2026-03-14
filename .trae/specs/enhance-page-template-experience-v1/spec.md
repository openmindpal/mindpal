# PageTemplate 高级形态与控制台品牌收尾 Spec

## Why
当前 PageTemplate 仅支持按 `pageType` 的硬编码渲染与少量 `ui` 配置项，缺少“可复用组件注册表、布局变体、用户级视图偏好、以及多端适配策略”。同时控制台仍存在默认脚手架品牌信息（如 `layout.tsx` 的默认标题），影响整体一致性与产品化体验。

## What Changes
- 引入 **Component Registry**：提供受控的“组件/块”注册表，PageTemplate 可引用 `componentId` 进行渲染组合。
- 引入 **Layout Variants**：为 list/detail/form 提供布局变体与参数（例如 table/cards、tabs/panels、single/two-column），并提供多端降级规则。
- 引入 **个人视图偏好**：用户可对某个 PageTemplate 保存视图偏好（列、排序、筛选、密度、布局变体等），运行时与 released 配置合并。
- 引入 **多端适配策略**：明确移动端/小屏的策略（布局降级、侧边栏策略、交互密度与触控友好），并把规则体现在渲染器与样式系统中。
- 控制台 **信息架构/品牌收尾**：
  - 修正 root `layout.tsx` 的默认 title/description 与 lang 设置。
  - 统一控制台导航分组与命名（治理/管理/运行/设置），减少“功能散落”与入口不一致。
- **不新增任意可执行脚本/任意组件动态加载能力**：Component Registry 仅允许代码内显式注册的组件，禁止 page config 指向任意模块或 URL。

## Impact
- Affected specs:
  - `advance-ui-templates-v1`（扩展 ui 配置块与渲染运行时）
  - `locale-preferences-v1` / locale defaults（用于 layout lang/title）
- Affected code:
  - Web：`apps/web/src/app/p/[page]/page.tsx`（渲染入口）、AppShell、导航与 layout
  - API：`apps/api/src/modules/uiConfig/pageModel.ts`、`apps/api/src/routes/ui.ts`（page schema 与接口）
  - 存储：新增“视图偏好”存储与查询（建议新表或复用 userPreferences 的结构化 key）

## ADDED Requirements

### Requirement: Component Registry
系统 SHALL 提供受控的 Component Registry，用于把 `componentId` 映射到前端可渲染组件，并在 API 层校验 PageTemplate 中引用的组件是否在 allowlist 中。

#### Scenario: 合法组件渲染
- **WHEN** released PageTemplate 引用 `componentId="EntityList.Table"` 且 props 合法
- **THEN** 前端渲染对应组件，并以 `ui` 与用户偏好合并后的 props 作为输入
- **AND** 不允许渲染 registry 未注册的 `componentId`

#### Scenario: 非法组件拒绝发布
- **WHEN** draft PageTemplate 引用 registry 未注册的 `componentId`
- **THEN** API 拒绝保存/发布，并返回可定位的错误（`UI_CONFIG_DENIED` 或明确错误码）

### Requirement: Layout Variants
系统 SHALL 为 PageTemplate 提供布局变体字段 `layout.variant`，并支持每个 `pageType` 的变体集合与默认值；运行时 SHALL 根据设备尺寸应用“变体降级规则”。

#### Scenario: list 变体切换
- **WHEN** `pageType=entity.list` 且 `layout.variant="cards"`
- **THEN** list 渲染为卡片布局（字段/排序/分页仍遵循同一套数据绑定与权限）

#### Scenario: 小屏降级
- **WHEN** `layout.variant` 为桌面双栏/复杂布局且 viewport 小于阈值
- **THEN** 渲染器自动降级到移动端安全布局（例如单列/折叠信息），且不影响数据正确性

### Requirement: 个人视图偏好（View Preferences）
系统 SHALL 支持用户对单个 PageTemplate 保存视图偏好，并在每次渲染时与 released 配置合并生成 effective view。

#### Scenario: 保存并生效
- **WHEN** 用户在页面上调整列顺序/可见列/排序/密度，并点击保存
- **THEN** 下次进入该页面时偏好自动生效

#### Scenario: 偏好校验与回退
- **WHEN** 用户偏好包含 schema 不存在字段或非法值
- **THEN** 系统忽略非法部分并回退到 released 默认，不崩溃

### Requirement: 多端适配策略
系统 SHALL 定义并实现多端适配策略：
- 侧边栏在窄屏隐藏或切换为可展开抽屉
- 列表默认列数/密度随屏幕缩小而减少
- 表单默认切换为单列，并保持字段可达性与可操作性

#### Scenario: 移动端列表可用性
- **WHEN** 用户在移动端打开 list 页
- **THEN** 页面显示更少的关键列、触控友好的行高/按钮尺寸，并仍可完成筛选/排序/分页

### Requirement: 控制台品牌与信息架构收尾
系统 SHALL 统一控制台品牌信息与 IA：
- `RootLayout` 的 title/description SHALL 使用产品名（不再是 Create Next App）
- `html lang` SHALL 与实际 locale 一致（至少支持 zh-CN/en-US）
- 控制台导航 SHALL 有清晰分组（例如：运行 / 治理 / 管理 / 设置），且入口命名一致

#### Scenario: Title/Lang 正确
- **WHEN** 用户以 `lang=zh-CN` 进入控制台
- **THEN** 页面 title 与 lang 使用中文 locale（或合理 fallback），不显示脚手架默认文案

## MODIFIED Requirements

### Requirement: PageTemplate UI 配置块（扩展）
现有 `ui` 配置块 SHALL 在保持向后兼容的前提下扩展：
- 允许新增 `layout` 与 `blocks`（或同等结构），但旧配置不变仍可渲染
- 旧字段（list/detail/form）语义不变；新增能力以增量方式启用

## REMOVED Requirements
无

