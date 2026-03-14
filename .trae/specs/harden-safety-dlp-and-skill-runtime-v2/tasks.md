# Tasks
- [x] Task 1: 梳理并固化 Safety Gate 目标与摘要契约
  - [x] SubTask 1.1: 定义 target 集合与处置模式（audit_only/deny_on_high_risk）
  - [x] SubTask 1.2: 定义 safetySummary 结构与审计落点字段
  - [x] SubTask 1.3: 明确错误码与拒绝分类（DLP vs Safety PI vs Runtime）

- [x] Task 2: 落地 Safety Gate 的统一拦截点（API/Worker）
  - [x] SubTask 2.1: API：tools/orchestrator/models/connectors/channels 统一接入 Safety Gate
  - [x] SubTask 2.2: Worker：tool/skill 执行回执与外发桥接接入 Safety Gate
  - [x] SubTask 2.3: 回归：脱敏与 deny 的一致性（多 target 覆盖）

- [x] Task 3: 外发最小化 V1（连接器/渠道）
  - [x] SubTask 3.1: 统一外发 envelope/摘要口径（不落明文大段内容）
  - [x] SubTask 3.2: 对 connector:egress 与 channel:send 强制执行脱敏/拒绝策略
  - [x] SubTask 3.3: 回归：外发拒绝/脱敏的审计与错误码稳定

- [x] Task 4: Skill 包与工具版本扫描摘要（V2）
  - [x] SubTask 4.1: 设计扫描规则集与摘要字段（不含原文）
  - [x] SubTask 4.2: 执行前校验：信任策略 + 扫描结果门槛
  - [x] SubTask 4.3: 增加治理只读查询：查看扫描摘要与阻断原因

- [x] Task 5: Runtime 资源配额扩展与出站计数
  - [x] SubTask 5.1: 扩展 limits（maxOutputBytes/maxEgressRequests）
  - [x] SubTask 5.2: 运行时执行中强制限制与分类（resource_limit）
  - [x] SubTask 5.3: 回归：超限路径的审计摘要与稳定错误分类

- [x] Task 6: 一键禁用与回滚最小闭环
  - [x] SubTask 6.1: 治理动作：禁用/回滚的 API 与审计事件
  - [x] SubTask 6.2: API/Worker 执行前检查禁用状态（阻断新执行）
  - [x] SubTask 6.3: 回归：禁用立即生效、回滚切换正确、拒绝错误码稳定

- [x] Task 7: 测试与文档回归
  - [x] SubTask 7.1: 覆盖：Safety Gate 多 target 的 deny/脱敏/摘要落库
  - [x] SubTask 7.2: 覆盖：外发最小化（connector/channel）
  - [x] SubTask 7.3: 覆盖：扫描摘要门槛 + 禁用/回滚 + 资源配额

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 1
- Task 5 depends on Task 1
- Task 6 depends on Task 4
- Task 7 depends on Task 2, Task 3, Task 4, Task 5, Task 6
