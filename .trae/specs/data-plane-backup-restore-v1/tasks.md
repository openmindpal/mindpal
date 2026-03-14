# Tasks
- [x] Task 1: 建立 Backup 元数据模型与查询接口
  - [x] SubTask 1.1: 新增 backups 表（tenant/space/status/runId/stepId/artifactId）
  - [x] SubTask 1.2: 实现 backupRepo（create/get/list/updateStatus）
  - [x] SubTask 1.3: 增加 `GET /spaces/:spaceId/backups`、`GET /backups/:backupId`

- [x] Task 2: 实现空间级备份作业（space.backup）
  - [x] SubTask 2.1: 增加 `POST /spaces/:spaceId/backups`（创建 run/step + backup 记录）
  - [x] SubTask 2.2: worker 支持 jobType=space.backup，导出 entity_records 到 backup artifact
  - [x] SubTask 2.3: 完成后更新 backup.status 与 backupArtifactId，并写审计摘要

- [x] Task 3: 实现空间级恢复（space.restore）
  - [x] SubTask 3.1: 增加 `POST /spaces/:spaceId/restores`（dry_run / commit）
  - [x] SubTask 3.2: dry_run：格式/兼容性/冲突摘要预检（不写入）
  - [x] SubTask 3.3: worker 支持 jobType=space.restore，commit 写入并生成 restore_report artifact
  - [x] SubTask 3.4: 写审计（restore.dry_run/restore.commit）并固化 policySnapshotRef

- [x] Task 4: 回归测试与文档
  - [x] SubTask 4.1: e2e：backup→artifact download→restore dry_run
  - [x] SubTask 4.2: e2e：restore commit 产出报告 + 冲突策略 fail/upsert
  - [x] SubTask 4.3: README：备份/恢复 API 示例与权限要求

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
