# Tasks
- [x] Task 1: 新增治理页面“Skill 包导入（artifactId）”
  - [x] SubTask 1.1: 新增 gov 路由与页面骨架（列表 + 上传表单）
  - [x] SubTask 1.2: 调用 `/artifacts/skill-packages/upload` 完成 zip/tgz 导入并展示摘要
  - [x] SubTask 1.3: 调用 `/artifacts/skill-packages` 展示最近导入列表（含复制 artifactId）
  - [x] SubTask 1.4: i18n 文案补齐（zh-CN/en-US）

- [x] Task 2: 支持治理侧基于 artifactId 发布工具版本
  - [x] SubTask 2.1: 在页面增加“发布工具版本”表单（toolName + artifactId + depsDigest 可选）
  - [x] SubTask 2.2: 后端调整 `/tools/:name/publish` 的“空发布内容”判定，允许仅变更 artifact 引用
  - [x] SubTask 2.3: 发布成功后展示 toolRef/version，并提供跳转到治理 tools 页的入口

- [x] Task 3: 验证与回归
  - [x] SubTask 3.1: 新增/更新 e2e：上传 skill 包得到 artifactId，然后 publish 使用 artifactId 成功
  - [x] SubTask 3.2: 回归：现有 publish 行为（非 artifact 变更）不受影响

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
