# Tasks
- [x] Task 1: 修复审计插件 outputDigest 合并逻辑
  - [x] SubTask 1.1: onSend：仅在 outputDigest 为空时写默认 length
  - [x] SubTask 1.2: onSend：outputDigest 已存在时 merge length 而不覆盖

- [x] Task 2: 测试与回归
  - [x] SubTask 2.1: e2e：断言 artifact 下载 token 的审计 output_digest 含 artifactId/tokenId
  - [x] SubTask 2.2: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 2 depends on Task 1
