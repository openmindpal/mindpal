# Tasks
- [x] Task 1: Skill Runtime V2 容器化后端与资源配额
  - [x] SubTask 1.1: 定义 runtime backend 选择与降级策略（process/container）
  - [x] SubTask 1.2: 在 worker 落地 container 执行器（最小可跑通）
  - [x] SubTask 1.3: 补齐 limits 资源配额语义与错误分类（resource_exhausted 等）

- [x] Task 2: 出站策略细粒度（host+path+method）
  - [x] SubTask 2.1: 扩展 networkPolicy V2 结构并保持 allowedDomains 兼容
  - [x] SubTask 2.2: 在 sandbox 中实现按 method/path 的拦截与 egressSummary 摘要
  - [x] SubTask 2.3: 增加回归：允许/拒绝/兼容模式路径

- [x] Task 3: 供应链治理升级（签名 + 依赖扫描摘要）
  - [x] SubTask 3.1: 定义 scanSummary 存储与审计摘要字段（不含依赖树原文）
  - [x] SubTask 3.2: 在发布/启用链路加入扫描门槛与可配置处置（deny/audit_only）
  - [x] SubTask 3.3: 回归：高危漏洞拒绝发布、签名失败拒绝、配置放行

- [x] Task 4: Model Gateway V2 Provider 扩展与路由策略对象
  - [x] SubTask 4.1: 新增 provider adapter（至少一个）并复用 Secrets/Connector/审计/用量归集
  - [x] SubTask 4.2: 引入路由策略对象（scope/purpose/candidates/fallbackPolicy）与治理读写接口
  - [x] SubTask 4.3: 调整未实现 provider 的最终错误语义并保持 attempts 诊断摘要

- [x] Task 5: 模型配额/预算（软/硬预算）
  - [x] SubTask 5.1: 定义预算对象与命中行为（降级/拒绝）及错误码
  - [x] SubTask 5.2: 在 /models/chat 执行前做预算判定并写可观测摘要
  - [x] SubTask 5.3: 提供治理只读聚合查询（预算命中率/超限次数）

- [x] Task 6: 编排闭环（Planner/Guard/Retriever/Executor）
  - [x] SubTask 6.1: 定义 plan/steps/guards/evidenceRefs 的标准结构与存储位置
  - [x] SubTask 6.2: 实现最小闭环状态机与失败 taxonomy（含 replan 条件）
  - [x] SubTask 6.3: 回归：检索→计划→执行→复核；失败→重试/降级/终止

- [x] Task 7: 端到端验证与文档
  - [x] SubTask 7.1: e2e 覆盖 container backend（可跳过条件说明）、资源配额、细粒度出站
  - [x] SubTask 7.2: e2e 覆盖 provider 扩展、路由策略、预算命中与错误语义
  - [x] SubTask 7.3: e2e 覆盖编排闭环的可回放摘要与审计字段
  - [x] SubTask 7.4: 更新相关 README/架构对齐说明（仅补充实现位置与配置项）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 5 depends on Task 4
- Task 6 depends on Task 4
- Task 7 depends on Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
