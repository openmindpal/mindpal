# Tasks
- [x] Task 1: 定义 Prompt Injection 检测与审计摘要契约
  - [x] SubTask 1.1: 新增 promptInjection 检测规则与返回结构（hits/score）
  - [x] SubTask 1.2: 定义 safetySummary.promptInjection 审计结构（不含原文）

- [x] Task 2: 接入 orchestrator 链路门禁
  - [x] SubTask 2.1: /orchestrator/turn 对 message 执行检测并写审计摘要
  - [x] SubTask 2.2: /orchestrator/execute 对 input 执行检测（deny 模式拒绝）

- [x] Task 3: 接入 tools.execute 链路门禁
  - [x] SubTask 3.1: /tools/:toolRef/execute 对 inputDraft/input 执行检测
  - [x] SubTask 3.2: deny 模式拒绝并返回稳定 errorCode

- [x] Task 4: 配置与测试回归
  - [x] SubTask 4.1: 增加 SAFETY_PI_MODE 与 SAFETY_PI_DENY_TARGETS 配置读取
  - [x] SubTask 4.2: e2e：audit_only 命中写审计但不拒绝
  - [x] SubTask 4.3: e2e：deny 模式对高危样本拒绝（orchestrator:execute/tool:execute）
  - [x] SubTask 4.4: 回归：不影响现有 DLP/授权/执行中心

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2
- Task 4 depends on Task 3
