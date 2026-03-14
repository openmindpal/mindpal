# Tasks

- [x] Task 1: 设计并实现 Workbench 插件数据模型与 Repo
  - [x] SubTask 1.1: 新增 workbench 插件/版本/active/canary 表与索引
  - [x] SubTask 1.2: 实现 workbenchRepo（create/update/version list/get active/effective）
  - [x] SubTask 1.3: 定义 manifest 校验与 digest 计算（默认拒绝能力）

- [x] Task 2: 增加 Workbench 插件 API 路由
  - [x] SubTask 2.1: 提供插件与版本的 CRUD（含 scope 隔离与 RBAC 校验）
  - [x] SubTask 2.2: 提供 effectiveVersion 查询（考虑 canary 决策）
  - [x] SubTask 2.3: 审计摘要与错误码对齐（不输出插件资产内容）

- [x] Task 3: 将 Workbench 发布/灰度/回滚纳入 changeset 治理
  - [x] SubTask 3.1: 新增 changeset item kind：publish/rollback/canary（最小集）
  - [x] SubTask 3.2: 实现 preflight 摘要输出（manifestDigest/capabilitiesSummary/riskHints）
  - [x] SubTask 3.3: release/apply 与 rollbackData 落库，支持一键回滚

- [x] Task 4: Web 实现 Workbench Sandbox Host 与消息桥
  - [x] SubTask 4.1: 新增 `/w/[workbenchKey]` 宿主路由与访问控制
  - [x] SubTask 4.2: 从 artifactRef 提供插件静态资产访问（受控路径）
  - [x] SubTask 4.3: 实现 postMessage 协议：数据绑定读取与动作触发（强制白名单校验）

- [x] Task 5: 增加最小管理入口与文档
  - [x] SubTask 5.1: 在治理控制台或管理页增加 workbench 列表/版本/发布入口（最小可用）
  - [x] SubTask 5.2: README 补充 workbench 插件打包 manifest、发布与灰度说明

- [x] Task 6: 验证与回归
  - [x] SubTask 6.1: API：manifest 拒绝、changeset publish/rollback/canary、effectiveVersion 决策
  - [x] SubTask 6.2: Web：iframe sandbox 与 CSP 生效、消息桥拒绝越权能力
  - [x] SubTask 6.3: e2e：最小插件发布后可加载并可查询实体数据（只读示例）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 2, Task 3, Task 4
- Task 6 depends on Task 1, Task 2, Task 3, Task 4
