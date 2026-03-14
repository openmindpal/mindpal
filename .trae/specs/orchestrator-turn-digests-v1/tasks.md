# Tasks
- [x] Task 1: 扩展 orchestrator_turns 表以支持 digest 留存
  - [x] SubTask 1.1: 新增 message_digest、tool_suggestions_digest 两个 JSONB 列
  - [x] SubTask 1.2: 迁移策略：保留旧列但停止写入（不做破坏性删除）

- [x] Task 2: Turn 写入 digest 并停止写入原文
  - [x] SubTask 2.1: 计算 messageDigest（长度、sha256_8 等）并写入
  - [x] SubTask 2.2: 计算 toolSuggestionsDigest（不含 inputDraft 原文）并写入
  - [x] SubTask 2.3: 审计 outputDigest 确认不包含原始 message/inputDraft

- [x] Task 3: Execute 绑定校验改为读取 digest
  - [x] SubTask 3.1: 绑定执行读取 toolSuggestionsDigest 查找 suggestion
  - [x] SubTask 3.2: 维持现有 404/409 错误码与行为不变

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: API e2e：turn 后查询 DB，确认仅写入 digest（无原文/无 inputDraft）
  - [x] SubTask 4.2: API e2e：绑定执行成功（不依赖 tool_suggestions 原文）
  - [x] SubTask 4.3: Web e2e：Orchestrator 冒烟保持通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
