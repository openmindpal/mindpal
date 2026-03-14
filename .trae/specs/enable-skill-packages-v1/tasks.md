# Tasks
- [x] Task 1: 定义并落库 artifactRef/depsDigest
  - [x] SubTask 1.1: tool_versions 增加 artifact_ref 字段并补齐索引
  - [x] SubTask 1.2: 明确 depsDigest 计算口径与落库策略

- [x] Task 2: 扩展 publish 与版本查询返回
  - [x] SubTask 2.1: publish 支持 artifactRef/depsDigest（并校验 manifest/契约一致性）
  - [x] SubTask 2.2: GET /tools/versions/:toolRef 返回 artifactRef/depsDigest

- [x] Task 3: Worker 动态 Skill 加载器
  - [x] SubTask 3.1: 实现 allowlist roots 校验与 file:// 解析
  - [x] SubTask 3.2: 动态 import 入口并适配 ExecutionRequest/Result
  - [x] SubTask 3.3: depsDigest 一致性校验与拒绝路径（policy_violation）
  - [x] SubTask 3.4: 保持内置工具回退路径不变

- [x] Task 4: 回归测试与文档
  - [x] SubTask 4.1: 单测：manifest 缺字段/路径越界/摘要不匹配
  - [x] SubTask 4.2: e2e：发布绑定包→启用→执行成功（最小示例 Skill）
  - [x] SubTask 4.3: README：Skill 包格式与本地开发流程

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
