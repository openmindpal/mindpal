# Tasks
- [x] Task 1: 下载接口输出水印/来源响应头
  - [x] SubTask 1.1: token 下载：设置 X-Artifact-Watermark-Id/X-Artifact-Source
  - [x] SubTask 1.2: （可选）bearer 下载：设置 X-Artifact-Watermark-Id/X-Artifact-Source

- [x] Task 2: 下载审计摘要写入 watermark/source
  - [x] SubTask 2.1: outputDigest 增加 watermarkId/artifactSource
  - [x] SubTask 2.2: 确保不影响既有 length/contentType/usesAfter 等字段

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: e2e：断言响应头存在且与 outputDigest 一致
  - [x] SubTask 3.2: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
