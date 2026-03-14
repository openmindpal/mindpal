# Tasks
- [x] Task 1: 新增 DLP 引擎（规则识别 + 脱敏）
  - [x] SubTask 1.1: 定义敏感类型集合与正则规则（token/key/email/phone）
  - [x] SubTask 1.2: 实现 redact() 与 dlpSummary 输出（不返回原文）
  - [x] SubTask 1.3: 单测覆盖典型样例与误伤边界

- [x] Task 2: API 统一执行点：审计写入前脱敏
  - [x] SubTask 2.1: 在写审计前对 inputDigest/outputDigest 应用 DLP
  - [x] SubTask 2.2: 将 dlpSummary 写入审计摘要字段（outputDigest）
  - [x] SubTask 2.3: 支持 DLP_MODE=audit_only|deny（deny 返回 DLP_DENIED）

- [x] Task 3: Worker 执行点：审计摘要脱敏
  - [x] SubTask 3.1: workflow 审计摘要写入前应用 DLP
  - [x] SubTask 3.2: knowledge index 审计摘要写入前应用 DLP

- [x] Task 4: Knowledge/Model 输出脱敏
  - [x] SubTask 4.1: evidence.snippet 返回前脱敏（不改库内原文）
  - [x] SubTask 4.2: /models/chat outputText 返回前脱敏（MVP provider）

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e 覆盖：审计摘要不含 token/key 原文
  - [x] SubTask 5.2: 覆盖：deny 模式命中密钥返回 DLP_DENIED
  - [x] SubTask 5.3: README 增加 DLP 配置与行为说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 5 depends on Task 2, Task 3, Task 4
