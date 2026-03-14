# Tasks

* [x] Task 1: 移除 API 的 uiMode 读写链路与存储

  * [x] 1.1：删除 `/settings/ui-mode` 的 GET/PUT 路由与相关审计 action

  * [x] 1.2：删除 `uiModeRepo` 模块与引用点

  * [x] 1.3：新增 DB 迁移：移除 `spaces.ui_mode` 字段与 check 约束

  * [x] 1.4：更新 API e2e：移除/改写 uiMode 用例

* [x] Task 2: Web 改为统一标准 Console

  * [x] 2.1：移除设置页“交互模式”区块与切换逻辑

  * [x] 2.2：ConsoleShell 不再接受/依赖 uiMode，导航不按模式折叠

  * [x] 2.3：移除各页面对 `/settings/ui-mode` 的读取（Runs/Gov/Admin/Home/Settings 等）

* [x] Task 3: 测试与文档回归

  * [x] 3.1：更新 Web e2e-console-mode：移除 setMode 与“隐藏治理入口”断言，新增统一导航/页面可加载断言

  * [x] 3.2：更新 README：删除/调整 uiMode 接口与模式说明

  * [x] 3.3：运行并通过：API tests、Web lint、Web e2e

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 1, Task 2
