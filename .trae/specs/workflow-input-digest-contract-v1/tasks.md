# Tasks
- [x] Task 1: 定义并实现 InputDigestV1 计算函数
  - [x] SubTask 1.1: 选择稳定序列化规则（对象 key 排序、数组顺序保留）
  - [x] SubTask 1.2: 摘要范围仅覆盖业务输入（排除 traceId/requestId 等元数据）

- [x] Task 2: runs/steps 写入 InputDigestV1
  - [x] SubTask 2.1: 创建 run 时写入 runs.input_digest=InputDigestV1
  - [x] SubTask 2.2: 创建 step 时写入 steps.input_digest=InputDigestV1（保留 steps.input 供执行）

- [x] Task 3: 调整 /replay/resolve 按 sha256_8 匹配
  - [x] SubTask 3.1: 请求体 inputDigest 校验改为 InputDigestV1（至少包含 sha256_8）
  - [x] SubTask 3.2: DB 查询按 steps.input_digest->>'sha256_8' 匹配

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: API e2e：相同业务输入不同 traceId 仍可 resolve 命中
  - [x] SubTask 4.2: API e2e：approval binding 与 replay resolve 仍一致（不泄露原始 payload）
  - [x] SubTask 4.3: 回归 orchestrator/execute 与既有 e2e 全通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
