- [x] 工具契约强校验：tools.execute 入参按 inputSchema 校验，失败返回可解释错误（tools.ts validateToolInput）
- [x] 风险→审批：risk=high 或 approvalRequired 必须进入 needs_approval 并创建审批记录（tools.ts）
- [x] Replay 只读：`GET /runs/:runId/replay` 仅输出 timeline/digest/引用，不泄露明文 payload（runs.ts、replay.ts）
- [x] Replay 无副作用：回放不得触发 tool 执行/入队/出站；仅允许写回放审计摘要（runs.ts）
- [x] Re-exec 新 run：`POST /runs/:runId/reexec` 新建 run/step，生成新幂等键/关联字段，不复用原幂等键（runs.ts）
- [x] Re-exec 可追溯：新 run 记录 reexec_of_run_id，审计事件 `workflow:reexec` 可观测（runs.ts）
- [x] 回归：API e2e 覆盖输入校验失败、needs_approval 的 replay、reexec 新 run 语义

## 可选（依赖架构-16）
- Replay 评测准入：eval runner 产出 eval_runs 并可治理触发
