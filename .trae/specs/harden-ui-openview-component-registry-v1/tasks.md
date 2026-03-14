# Tasks
- [x] Task 1: 为 uiDirective openView 增加前端白名单校验与降级
  - [x] SubTask 1.1: 在 Chat UI 中实现 openView=page 的存在性校验（基于 /ui/pages/:name）
  - [x] SubTask 1.2: 在 Chat UI 中实现 openView=workbench 的存在性校验（基于 /workbenches/:workbenchKey/effective）
  - [x] SubTask 1.3: 失败时不渲染跳转入口（或显示不可打开提示），确保不“信任回执直接跳转”

- [x] Task 2: 补齐 ViewPrefs 端到端回归（写入→生效→重置）
  - [x] SubTask 2.1: 扩展 Web e2e 脚本：PUT view-prefs 后 GET /p/:name 断言列变化
  - [x] SubTask 2.2: 扩展 Web e2e 脚本：DELETE view-prefs 后 GET /p/:name 断言恢复默认
  - [x] SubTask 2.3: 补齐必要的测试前置（确保目标页面存在且已发布）

- [x] Task 3: 新增 UI 组件注册表 allowlist 的版本化存储
  - [x] SubTask 3.1: 新增 migration：ui_component_registry_versions（tenant/space 作用域、draft/released、version、componentIds）
  - [x] SubTask 3.2: 新增 repo：读取 latest released / upsert draft / publish / rollback

- [x] Task 4: 新增组件注册表治理 API 与审计
  - [x] SubTask 4.1: 新增路由：GET registry、PUT draft、POST publish、POST rollback（含稳定错误码）
  - [x] SubTask 4.2: 新增权限动作（governance.ui.component_registry.read/write/release）并接入 requirePermission
  - [x] SubTask 4.3: 审计摘要包含 version、componentCount、拒绝原因摘要（不记录实现细节）

- [x] Task 5: 将 PageTemplate 校验接入治理 allowlist
  - [x] SubTask 5.1: 扩展 validateDraft：componentId 需同时满足“代码 registry 存在 + 治理 allowlist 允许（若存在）”
  - [x] SubTask 5.2: 回归：未配置 allowlist 时保持向后兼容（仍允许代码 registry 内全部组件）

- [x] Task 6: 补齐回归测试（API + Web）
  - [x] SubTask 6.1: API e2e：registry publish/rollback、未知 componentId 拒绝、PageTemplate 引用被拒绝
  - [x] SubTask 6.2: Web e2e：uiDirective openView=page 指向未发布页面时不出现可点击跳转入口

# Task Dependencies
- Task 2 depends on Task 1 (复用同一套 Chat/UI 页面与 API 基础设施)
- Task 4 depends on Task 3
- Task 5 depends on Task 3, Task 4
- Task 6 depends on Task 1, Task 2, Task 4, Task 5
