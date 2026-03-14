# Tasks
- [x] Task 1: 设计 V1 指标模型与聚合维度
  - [x] 定义指标名称、标签集合与禁止字段（防高基数）
  - [x] 明确 routePattern 获取方式（避免把 runId/stepId 等动态段作为标签）
- [x] Task 2: 在 API 请求管线接入指标采集
  - [x] onRequest/onResponse/onError 采集请求计数与延迟
  - [x] 在授权拒绝与审计失败路径更新对应计数器
- [x] Task 3: 新增 /metrics 路由与访问控制
  - [x] 输出 Prometheus 文本格式与稳定的指标名/标签
  - [x] 复用现有鉴权/授权体系限制访问
- [x] Task 4: 回归测试与最小验证
  - [x] e2e：发起若干请求后 /metrics 包含计数与延迟指标
  - [x] e2e：未授权访问 /metrics 被拒绝

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
