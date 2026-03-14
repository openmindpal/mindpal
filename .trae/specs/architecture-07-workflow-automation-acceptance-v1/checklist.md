- [x] 审批闭环：risk=high 或 approvalRequired 的执行进入 needs_approval 且创建审批记录（tools.ts/approvals.ts）
- [x] 审批闭环：approve 后继续执行复用原 step 绑定校验（不允许绕过校验）
- [x] 审批闭环：approve 后继续执行保留并沿用 policySnapshotRef
- [x] 审批闭环：写工具缺少 idempotencyKey 必须拒绝（含审批通过路径）
- [x] 死信/重试/取消：deadletters 列表接口可分页返回 runId/stepId/toolRef/错误摘要（053_workflow_deadletter_reexec.sql）
- [x] 死信/重试/取消：对 deadletter step 执行 retry 可重新入队/执行且审计到位（runs.ts）
- [x] 死信/重试/取消：对 deadletter run/step 执行 cancel 状态正确且审计到位（runs.ts）
- [x] 补偿/撤销（SAGA）：对有副作用写操作可注册补偿 step（091_triggers_and_compensations.sql、061_workflow_step_compensation_envelope.sql）
- [x] 补偿/撤销（SAGA）：提供触发补偿的 API/治理入口，并接入权限动作与 scope 校验
- [x] 补偿/撤销（SAGA）：补偿执行走 run/step 生命周期，可 retry/cancel，可审计（仅摘要）
- [x] 回归：相关 API/worker/web 测试可跑通，且审计事件在关键路径可观测

## 可重复验证
- npm run verify:arch07
