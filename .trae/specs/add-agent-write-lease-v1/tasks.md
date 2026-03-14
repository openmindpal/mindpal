# Tasks
- [x] Task 1: 增加写租约数据模型与访问层
  - [x] SubTask 1.1: 新增 workflow_write_leases 表与必要索引
  - [x] SubTask 1.2: 实现 acquire/renew/release 的 repo 方法（TTL 语义）

- [x] Task 2: Worker 写入执行路径接入 Write Lease
  - [x] SubTask 2.1: 识别写入类工具并计算 resourceRef（MVP 覆盖 entity.* 与 memory.write）
  - [x] SubTask 2.2: 执行前获取租约；busy 返回 retryable 错误与 backoff
  - [x] SubTask 2.3: 执行中按需续期；结束释放（success/error 都释放）

- [x] Task 3: 审计摘要对齐
  - [x] SubTask 3.1: busy 拒绝写入时写审计（含 leaseKeyDigest/ownerDigest）
  - [x] SubTask 3.2: 租约异常/续期失败的错误分类与审计摘要

- [x] Task 4: 回归测试
  - [x] SubTask 4.1: worker：并发写同一资源只允许一个成功（另一个 retryable）
  - [x] SubTask 4.2: worker：TTL 过期后可重新获取
  - [x] SubTask 4.3: e2e（可选）：覆盖一个典型写入工具的 busy 行为

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2, Task 3
