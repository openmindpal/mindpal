# Tasks
- [x] Task 1: 扩展 Tool Contract 数据模型与发布校验
  - [x] SubTask 1.1: tool_definitions 增加 scope/resourceType/action/idempotencyRequired
  - [x] SubTask 1.2: publish API 校验必填字段与兼容策略
  - [x] SubTask 1.3: 工具列表/详情返回新增字段

- [x] Task 2: 对齐 effective toolRef 解析与治理启用
  - [x] SubTask 2.1: 新增 resolveEffectiveToolRef（override→active→latest）
  - [x] SubTask 2.2: 执行入口与 orchestrator 统一使用 effective toolRef
  - [x] SubTask 2.3: rollout 未启用拒绝（稳定错误码 + 审计）

- [x] Task 3: 落地 approvalRequired 闭环（needs_approval→approve/reject）
  - [x] SubTask 3.1: run/step 状态机扩展（needs_approval）并阻断 worker 执行
  - [x] SubTask 3.2: 新增审批 API（approve/reject）与审计
  - [x] SubTask 3.3: 执行回执标准化（receipt）

- [x] Task 4: outputSchema 校验与输出裁剪
  - [x] SubTask 4.1: worker 对 output 做 schema 校验与失败分类
  - [x] SubTask 4.2: 输出裁剪与 outputDigest 摘要化

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e：write 缺幂等键拒绝
  - [x] SubTask 5.2: e2e：approvalRequired 返回 needs_approval，approve 后执行
  - [x] SubTask 5.3: e2e：rollout disabled 拒绝 + 审计可追溯
  - [x] SubTask 5.4: README：Tool Contract V1 字段与回执示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 1
- Task 5 depends on Task 2, Task 3, Task 4
