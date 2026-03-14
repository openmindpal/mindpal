# Tasks
- [x] Task 1: 建立 Artifact 数据模型与下载接口
  - [x] SubTask 1.1: 新增 artifacts 表与最小索引（tenant/space/type/createdAt）
  - [x] SubTask 1.2: 实现 artifacts repo（create/get/download ref）
  - [x] SubTask 1.3: 增加 `GET /artifacts/:artifactId/download`（鉴权 + DLP）

- [x] Task 2: 实现实体导出（export）作业
  - [x] SubTask 2.1: 增加 `POST /entities/:entity/export`（创建 run/step）
  - [x] SubTask 2.2: worker 支持 jobType=entity.export，按 query 分片拉取并裁剪字段
  - [x] SubTask 2.3: 生成 export artifact（jsonl/json）并写审计摘要

- [x] Task 3: 实现实体导入（import）预检与作业
  - [x] SubTask 3.1: 增加 `POST /entities/:entity/import`（dry_run 与 commit）
  - [x] SubTask 3.2: dry_run：schema 校验 + fieldRules.write 校验 + 统计摘要
  - [x] SubTask 3.3: worker 支持 jobType=entity.import，commit 写入与幂等
  - [x] SubTask 3.4: 生成 import_report artifact（统计与错误摘要）

- [x] Task 4: 回归测试与文档
  - [x] SubTask 4.1: e2e：export→artifact download（含 fieldRules.read 裁剪）
  - [x] SubTask 4.2: e2e：import dry_run 拒绝非法字段/类型；commit 产出报告
  - [x] SubTask 4.3: README：Bulk IO API 示例与限制（大小/条数/格式）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
