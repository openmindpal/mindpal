# Tasks
- [x] Task 1: 为 steps 表新增出参加密字段
  - [x] SubTask 1.1: 迁移新增 output_enc_format/output_key_version/output_encrypted_payload
  - [x] SubTask 1.2: 保持兼容（历史 step 不回填、不破坏）

- [x] Task 2: Worker 成功写入时加密完整 output 并最小化 steps.output
  - [x] SubTask 2.1: 以 scopeType=space/scopeId=spaceId 加密完整 output
  - [x] SubTask 2.2: steps.output 仅保留安全展示字段（例如 outputDigest/脱敏摘要）

- [x] Task 3: 回归与测试
  - [x] SubTask 3.1: Worker 测试：加密 output 写入成功且不泄露明文
  - [x] SubTask 3.2: API e2e：对外返回不含敏感明文 output
  - [x] SubTask 3.3: 回归：回放/审批/编排相关用例通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
