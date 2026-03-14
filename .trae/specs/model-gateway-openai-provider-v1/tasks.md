# Tasks
- [x] Task 1: 扩展 Model Catalog 增加 openai 条目
  - [x] SubTask 1.1: 在 catalog 中新增 openai modelRef 与 endpointHost
  - [x] SubTask 1.2: 确保 /models/bindings 创建时可识别该 modelRef

- [x] Task 2: 实现 OpenAI Provider Adapter
  - [x] SubTask 2.1: 从 SecretRecord 解密 apiKey（不落日志/不落审计原文）
  - [x] SubTask 2.2: 调用 OpenAI chat.completions（messages → outputText）并支持 timeout
  - [x] SubTask 2.3: 上游错误映射为稳定 errorCode（含 traceId）与审计错误分类

- [x] Task 3: 审计与安全对齐
  - [x] SubTask 3.1: 审计记录 routingDecision、latencyMs、usage 摘要与 errorCategory
  - [x] SubTask 3.2: 确认不记录 prompts 原文与 apiKey（仅摘要）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: 添加测试覆盖 openai provider 分支（成功/失败/超时）
  - [x] SubTask 4.2: 回归覆盖：allowedDomains 拒绝、限流 429、审计落库

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2, Task 3
