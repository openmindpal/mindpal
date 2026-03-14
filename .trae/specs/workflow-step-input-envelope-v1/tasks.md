# Tasks
- [x] Task 1: 为 steps 表新增入参加密字段
  - [x] SubTask 1.1: 迁移新增 input_enc_format/input_key_version/input_encrypted_payload
  - [x] SubTask 1.2: 保持兼容（历史 step 不回填、不破坏）

- [x] Task 2: 创建 step 时写入 envelope.v1 并最小化 steps.input
  - [x] SubTask 2.1: 以 scopeType=space/scopeId=spaceId 加密完整 input
  - [x] SubTask 2.2: steps.input 仅保留 spaceId/toolRef/kind 等元信息

- [x] Task 3: Worker 执行时支持解密读取 input
  - [x] SubTask 3.1: 优先解密 input_encrypted_payload（envelope.v1）
  - [x] SubTask 3.2: 无加密字段时回退使用 steps.input（兼容历史）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: Worker 测试：加密 step 可执行且不泄露明文入参
  - [x] SubTask 4.2: API e2e：创建 step 后 DB 中 steps.input 不含 payload
  - [x] SubTask 4.3: 回归：replay/resolve、approval、orchestrator 相关用例通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
