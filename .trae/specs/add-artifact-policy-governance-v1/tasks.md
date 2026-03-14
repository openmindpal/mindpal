# Tasks
- [x] Task 1: 落库 ArtifactPolicy（space/tenant）
  - [x] SubTask 1.1: 新增 migration：artifact_policies 表与索引
  - [x] SubTask 1.2: 新增 repo：get/upsert/getEffective（space 优先）

- [x] Task 2: 治理 API 接入与权限审计
  - [x] SubTask 2.1: GET/PUT /governance/artifact-policy
  - [x] SubTask 2.2: 权限 artifact.policy.read/write + 审计摘要

- [x] Task 3: token 签发改为治理注入
  - [x] SubTask 3.1: /artifacts/:artifactId/download-token 忽略客户端 expiresInSec/maxUses
  - [x] SubTask 3.2: 未配置时使用安全默认值

- [x] Task 4: 水印响应头支持策略开关
  - [x] SubTask 4.1: watermarkHeadersEnabled=false 时不输出响应头
  - [x] SubTask 4.2: 审计仍保留 watermarkId/artifactSource

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: e2e：客户端传参不生效，按治理配置生效
  - [x] SubTask 5.2: e2e：未配置使用默认值
  - [x] SubTask 5.3: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 5 depends on Task 2
