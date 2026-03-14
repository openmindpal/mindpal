# Tasks
- [x] Task 1: 定义 Orchestrator 回执与输入契约
  - [x] SubTask 1.1: 定义请求体（message、locale、可选上下文）
  - [x] SubTask 1.2: 定义响应体（replyText、toolSuggestions、uiDirective）
  - [x] SubTask 1.3: 定义 uiDirective（openView/viewParams/openMode）与白名单约束

- [x] Task 2: 实现 Orchestrator API（/orchestrator/turn）
  - [x] SubTask 2.1: 接入统一请求链路：鉴权/授权/审计（resourceType=orchestrator）
  - [x] SubTask 2.2: 从 Tool Registry 读取已发布工具并生成候选建议（MVP 简单规则）
  - [x] SubTask 2.3: 生成/透传 traceId，并为建议生成 idempotencyKey（写工具场景）

- [x] Task 3: 实现工具契约校验（MVP 子集）
  - [x] SubTask 3.1: 校验 toolRef 存在且 released
  - [x] SubTask 3.2: 校验 inputDraft 满足 inputSchema（必填/类型子集）
  - [x] SubTask 3.3: 对无效建议降级处理（不返回或标记 invalid）并写审计摘要

- [x] Task 4: 回归测试与文档补齐
  - [x] SubTask 4.1: 覆盖：生成 toolSuggestions、生成 uiDirective、非法 toolRef 不返回
  - [x] SubTask 4.2: 覆盖：审计事件落库（resourceType=orchestrator）
  - [x] SubTask 4.3: 更新 README：Orchestrator 入口与示例请求/响应

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2, Task 3
