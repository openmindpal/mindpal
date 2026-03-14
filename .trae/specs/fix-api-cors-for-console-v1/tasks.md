# Tasks
- [x] Task 1: 在 API 层增加受控 CORS 支持
  - [x] SubTask 1.1: 增加全局 CORS 处理（含 OPTIONS 预检）
  - [x] SubTask 1.2: 允许 Origin 列表配置化（默认 localhost:3000）
  - [x] SubTask 1.3: 覆盖 Console 所需 allow-methods/allow-headers

- [x] Task 2: 回归验证
  - [x] SubTask 2.1: 浏览器中切换简易/治理模式不再报 CORS
  - [x] SubTask 2.2: Web e2e 或最小脚本验证 /settings/ui-mode 预检与实际请求

# Task Dependencies
- Task 2 depends on Task 1
