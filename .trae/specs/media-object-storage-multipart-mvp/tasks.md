# Tasks
- [x] Task 1: 设计并落地 Blob Store 抽象与本地 FS 后端
  - [x] SubTask 1.1: 定义接口与配置项（rootDir、单分片/总大小上限、过期清理周期）
  - [x] SubTask 1.2: 实现 fs 后端：put/get/compose（含目录穿越防护）

- [x] Task 2: 扩展 Media 数据模型以支持 contentRef
  - [x] SubTask 2.1: DB migrations：media_objects 增加 storage_provider/storage_key（保留 content_bytes 兼容）
  - [x] SubTask 2.2: Repo：创建对象时写入 storageKey；下载时优先读 storageKey

- [x] Task 3: 实现分片上传会话 API
  - [x] SubTask 3.1: DB migrations：media_uploads / media_upload_parts（或等价结构）
  - [x] SubTask 3.2: Routes：create part upload / complete / abort
  - [x] SubTask 3.3: RBAC + 审计对齐（upload/complete/download）

- [x] Task 4: 回归测试与最小验证
  - [x] SubTask 4.1: e2e：分片上传→complete→download 内容一致
  - [x] SubTask 4.2: e2e：超限行为（拒绝或不接受 part）
  - [x] SubTask 4.3: e2e：跨 space 访问拒绝 + 审计不泄露原文

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 3
