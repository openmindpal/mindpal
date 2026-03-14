# Tasks
- [x] Task 1: 新增 Settings Hub 页面与入口聚合
  - [x] SubTask 1.1: 增加 /settings（或现有设置路由下）页面骨架与卡片布局
  - [x] SubTask 1.2: 为每个入口补齐跳转链接（复用现有页面路由）

- [x] Task 2: 入口可见性按 RBAC/Policy 控制
  - [x] SubTask 2.1: 为各入口选择代表性 API 并实现探测（403/denied 隐藏或禁用）
  - [x] SubTask 2.2: 不泄露任何 secret 明文或敏感字段

- [x] Task 3: i18n 与 WEB_E2E
  - [x] SubTask 3.1: 补齐 zh-CN/en-US 文案 keys
  - [x] SubTask 3.2: WEB_E2E smoke 断言设置页与关键入口文案存在

- [x] Task 4: 回归
  - [x] SubTask 4.1: web 测试通过（含 WEB_E2E）
  - [x] SubTask 4.2: api/worker 回归不受影响

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
