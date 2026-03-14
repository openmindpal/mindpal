# Tasks
- [x] Task 1: 固化写入单主冲突验收断言
  - [x] SubTask 1.1: e2e 覆盖并发写冲突返回 409 与稳定错误码
  - [x] SubTask 1.2: e2e 断言 violation 事件/审计摘要可追溯（按 correlationId/taskId）

- [x] Task 2: 固化协作 Envelope 可观测验收断言
  - [x] SubTask 2.1: e2e 断言 collab_envelopes 落表且包含 correlation 与摘要字段
  - [x] SubTask 2.2: e2e 断言可按 correlationId 串联 envelopes/events/diagnostics

- [x] Task 3: 固化最小共享与脱敏验收断言
  - [x] SubTask 3.1: e2e 抽样断言 envelopes/events 不含敏感 payload 明文（仅 ref/digest）
  - [x] SubTask 3.2: e2e 抽样断言 audit_events.output_digest 不含敏感 payload 明文
  - [x] SubTask 3.3: 如发现泄露点，收敛输出为 ref/digest 并补回归

- [x] Task 4: 全量回归
  - [x] SubTask 4.1: 运行 api/worker/web 测试确保无回归

# Task Dependencies
- Task 3 depends on Task 2
- Task 4 depends on Task 1, Task 2, Task 3
