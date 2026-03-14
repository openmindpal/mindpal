# Tasks
- [x] Task 1: 新增 Media Contract 数据模型与迁移
  - [x] SubTask 1.1: DB migrations：media_objects / media_derivatives / media_jobs
  - [x] SubTask 1.2: 索引与约束（tenant/space 隔离、sha256 查询、状态字段约束）

- [x] Task 2: 实现 MediaObject API（上传/下载/读取）
  - [x] SubTask 2.1: Repo：create/get/download（MVP 存储形态实现）
  - [x] SubTask 2.2: Routes：POST /media/objects、GET /media/objects/:id/download、GET /media/objects/:id
  - [x] SubTask 2.3: RBAC + 审计对齐（upload/download/read）

- [x] Task 3: 实现处理流水线入口（Job + Worker）
  - [x] SubTask 3.1: Routes：POST /media/objects/:id/process（创建 job 并投递队列）
  - [x] SubTask 3.2: Worker：media.process（MVP 状态流转 + derivatives 占位）
  - [x] SubTask 3.3: 失败重试与错误摘要（不泄露敏感内容）

- [x] Task 4: 最小回归测试
  - [x] SubTask 4.1: API e2e：上传→下载内容一致；跨 space 拒绝；审计可检索
  - [x] SubTask 4.2: Worker 单测或 e2e：process 创建→完成，derivatives 可查询

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2, Task 3
