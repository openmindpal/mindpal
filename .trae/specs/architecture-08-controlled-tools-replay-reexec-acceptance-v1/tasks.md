# Tasks
- [x] Task 1: 工具契约强校验验收对齐
  - [x] SubTask 1.1: 复核 tools.ts 的 validateToolInput 错误可解释性与稳定 errorCode
  - [x] SubTask 1.2: 复核 risk=high/approvalRequired 的 needs_approval 分流与审批记录创建
  - [x] SubTask 1.3: 补齐/更新 API e2e 覆盖输入校验失败与风险→审批路径

- [x] Task 2: Replay 只读语义验收对齐
  - [x] SubTask 2.1: 复核 runs.ts replay 输出仅含 timeline/digest/引用（不含明文 payload）
  - [x] SubTask 2.2: 复核 replay 不触发 tool 执行/入队/出站（除回放审计事件外无写副作用）
  - [x] SubTask 2.3: 补齐/更新 API e2e 覆盖 needs_approval/queued/canceled 的 replay timeline

- [x] Task 3: Re-exec 语义验收对齐
  - [x] SubTask 3.1: 复核 runs.ts reexec：新建 run/step、生成新幂等键、写 reexec_of_run_id
  - [x] SubTask 3.2: 复核 reexec 仍受审批/幂等/授权规则约束
  - [x] SubTask 3.3: 补齐/更新 API e2e 覆盖 reexec 新 run 与审计链路

## 可选（依赖架构-16）
- Replay 评测准入产品化：补齐 eval runner，将 replay 结果与期望对比产出 eval_runs，并提供治理入口触发（含审计摘要）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
