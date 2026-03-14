# Tasks
- [x] Task 1: 增加 artifact 下载 token 存储与仓储
  - [x] SubTask 1.1: 新增 migration：artifact_download_tokens 表与索引
  - [x] SubTask 1.2: 新增 repo：createToken/consumeToken/getTokenByHash

- [x] Task 2: 增加下载 token API 与审计
  - [x] SubTask 2.1: POST /artifacts/:artifactId/download-token（签发 + 审计）
  - [x] SubTask 2.2: GET /artifacts/download?token=...（消费 + 次数限制 + 审计）
  - [x] SubTask 2.3: 错误码与拒绝分类（ARTIFACT_TOKEN_DENIED）

- [x] Task 3: 前端治理审计页改为 token 下载
  - [x] SubTask 3.1: audit UI 点击下载先签发 token
  - [x] SubTask 3.2: 用 downloadUrl 触发下载，错误展示保持一致

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: e2e：签发 token 后可下载
  - [x] SubTask 4.2: e2e：token 过期/用尽/撤销拒绝
  - [x] SubTask 4.3: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2
