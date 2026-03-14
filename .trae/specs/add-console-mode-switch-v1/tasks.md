# Tasks
- [x] Task 1: 增加空间级 uiMode 配置与读写 API
  - [x] SubTask 1.1: 设计并新增存储结构（space 配置表或扩展字段）与迁移
  - [x] SubTask 1.2: 增加读取当前空间 uiMode 的接口（用于 Web 初始化）
  - [x] SubTask 1.3: 增加修改 uiMode 的接口（权限校验、审计、幂等等）

- [x] Task 2: Web 增加 Console 设置页与模式切换交互
  - [x] SubTask 2.1: 增加设置页路由与当前 uiMode 展示
  - [x] SubTask 2.2: 增加切换控件与二次确认（治理模式提示）
  - [x] SubTask 2.3: 错误展示遵循标准错误模型（errorCode/message/traceId）

- [x] Task 3: Web 导航按 uiMode 分层并保持 RBAC 强制保护
  - [x] SubTask 3.1: 导航结构拆分为“简易/治理”两组并按 uiMode 渲染
  - [x] SubTask 3.2: 在简易模式下隐藏治理入口链接，但不移除治理路由
  - [x] SubTask 3.3: 对治理路由的访问仍以服务端 RBAC 为准（前端仅做 UI 折叠）

- [x] Task 4: 测试与回归验证
  - [x] SubTask 4.1: 增加 API 单测/集成测试覆盖：读取默认值、成功切换、无权限拒绝
  - [x] SubTask 4.2: 增加 Web e2e 覆盖：切换模式后导航变化、治理页直达仍受 RBAC
  - [x] SubTask 4.3: 更新 README 或相关文档：说明 uiMode 语义与权限要求

- [x] Task 5: 设置页扩展为轻便 Console（能力入口与列表摘要）
  - [x] SubTask 5.1: 在 /settings 增加“模型绑定/通道管理/技能列表/定时任务”四分区
  - [x] SubTask 5.2: 为各分区增加刷新与错误展示（errorCode/message/traceId）

- [x] Task 6: 设置页实现模型绑定管理（Model Gateway）
  - [x] SubTask 6.1: 展示 catalog 与 bindings 列表摘要
  - [x] SubTask 6.2: 提供创建 binding 的最小表单并调用 POST /models/bindings

- [x] Task 7: 设置页实现通道管理（Connectors/Secrets）
  - [x] SubTask 7.1: 展示 connector instances 与 secrets 列表摘要
  - [x] SubTask 7.2: 提供创建 ConnectorInstance、创建 Secret 的最小表单

- [x] Task 8: 设置页实现定时任务管理（Subscriptions）
  - [x] SubTask 8.1: 展示 subscriptions 列表摘要
  - [x] SubTask 8.2: 提供创建 subscription、enable/disable 的最小操作

- [x] Task 9: 设置页实现技能列表（Tools）
  - [x] SubTask 9.1: 展示 tools 列表摘要（含 active/effectiveActive）

- [x] Task 10: 测试与文档回归（轻便 Console）
  - [x] SubTask 10.1: Web e2e 脚本覆盖设置页分区存在与基础拉取
  - [x] SubTask 10.2: README 补充 /settings 的能力说明与相关接口

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1, Task 2, Task 3
- Task 5 depends on Task 2
- Task 6 depends on Task 5
- Task 7 depends on Task 5
- Task 8 depends on Task 5, Task 7
- Task 9 depends on Task 5
- Task 10 depends on Task 5, Task 6, Task 7, Task 8, Task 9
