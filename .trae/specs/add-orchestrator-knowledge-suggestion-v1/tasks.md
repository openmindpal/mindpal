# Tasks
- [x] Task 1: 扩展 Orchestrator turn 以支持 knowledge.search 建议
  - [x] 识别搜索意图关键词并构造 query 草稿（裁剪长度与去空白）
  - [x] resolveEffectiveToolRef 获取 knowledge.search 的有效 toolRef
  - [x] 校验工具版本 released 且 inputDraft 通过 inputSchema 校验
  - [x] 生成 toolSuggestion（包含 scope/resourceType/action/riskLevel/approvalRequired/idempotencyKey）
- [x] Task 2: 补齐 e2e 测试覆盖
  - [x] 在测试中 publish+enable knowledge.search@1
  - [x] 调用 /orchestrator/turn（搜索意图）断言 toolSuggestions 包含 knowledge.search
  - [x] 断言 inputDraft.query 与 inputSchema 校验一致

# Task Dependencies
- Task 2 depends on Task 1
