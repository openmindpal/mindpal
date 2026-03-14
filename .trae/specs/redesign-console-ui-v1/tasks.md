# Tasks
- [x] Task 1: 建立管理台 AppShell 与基础组件库
  - [x] SubTask 1.1: 新增 AppShell（Header/SideNav/Content）与响应式布局
  - [x] SubTask 1.2: 新增基础组件（PageHeader/Card/Table/Badge）与统一样式变量
  - [x] SubTask 1.3: 接入 i18n keys，确保 TS/TSX 无中文

- [x] Task 2: 重构 /settings 为轻便 Console 卡片化分区
  - [x] SubTask 2.1: 分区骨架与分区级刷新/错误三态
  - [x] SubTask 2.2: 模型绑定分区：列表摘要 + 最小创建表单
  - [x] SubTask 2.3: 通道管理分区：connectors/secrets 列表摘要 + 最小创建表单
  - [x] SubTask 2.4: 定时任务分区：subscriptions 列表摘要 + create/enable/disable
  - [x] SubTask 2.5: 技能列表分区：tools 列表摘要（active/effective）

- [x] Task 3: 管理页统一接入 AppShell 并按 uiMode 折叠导航
  - [x] SubTask 3.1: /admin/ui、/admin/rbac 等页面统一使用 AppShell
  - [x] SubTask 3.2: Home 页入口与导航更新（simple/governance）
  - [x] SubTask 3.3: 保持 RBAC 强制保护不变（仅做 UI 折叠）

- [x] Task 4: 回归验证与可用性收尾
  - [x] SubTask 4.1: 更新 Web e2e 脚本校验：导航折叠与分区存在
  - [x] SubTask 4.2: 跑 Web lint（含 check-no-zh）与 workspaces test
  - [x] SubTask 4.3: README 补充管理台界面说明与截图占位（可选）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1, Task 2, Task 3
