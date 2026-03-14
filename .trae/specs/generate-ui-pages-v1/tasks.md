# Tasks
- [x] Task 1: 实现 PageTemplate 生成器（API）
  - [x] SubTask 1.1: 定义 generator 输入/输出模型与稳定 errorCode
  - [x] SubTask 1.2: 读取 Effective Schema 并生成 entity.list/detail/new/edit 的 draft PageTemplate
  - [x] SubTask 1.3: 选择并校验 entity.create/entity.update 的最新 released toolRef

- [x] Task 2: 新增生成接口与审计
  - [x] SubTask 2.1: `POST /ui/page-templates/generate`（仅治理权限）
  - [x] SubTask 2.2: 审计：resourceType=ui_config, action=generate（仅摘要）
  - [x] SubTask 2.3: overwriteStrategy：skip_existing / overwrite_draft

- [x] Task 3: Web/UI 最小入口
  - [x] SubTask 3.1: UI 配置管理页增加“生成默认页面”操作
  - [x] SubTask 3.2: 生成后提示用户 review + publish（复用现有发布流程）

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: e2e：生成→发布→导航可见；缺少 toolRef/非法 binding 拒绝
  - [x] SubTask 4.2: README：生成器使用说明与约束（Effective Schema/白名单/不自动发布）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
