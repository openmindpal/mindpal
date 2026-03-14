# Tasks
- [x] Task 1: audit_events 增加 hash chain 字段与不可变触发器
  - [x] SubTask 1.1: 新增 migrations：audit_events 增加 prev_hash/event_hash 字段与索引
  - [x] SubTask 1.2: 新增 migrations：禁止 audit_events UPDATE/DELETE 的触发器

- [x] Task 2: 审计写入链式摘要
  - [x] SubTask 2.1: 实现规范化摘要与 hash 计算函数（稳定序列化）
  - [x] SubTask 2.2: insertAuditEvent 在事务内读取上一条 hash 并写入 prev_hash/event_hash
  - [x] SubTask 2.3: 同 tenant 并发写入使用事务级锁确保顺序可验证

- [x] Task 3: 完整性校验接口
  - [x] SubTask 3.1: 实现 verifyAuditChain（按 tenant/时间窗扫描与校验）
  - [x] SubTask 3.2: 增加 `GET /audit/verify`（鉴权+审计 action=verify）

- [x] Task 4: 回归测试与文档
  - [x] SubTask 4.1: 单测：hash 计算稳定性（同输入同 hash）
  - [x] SubTask 4.2: e2e：写入多条审计后 verify 返回 ok=true
  - [x] SubTask 4.3: e2e：尝试 UPDATE/DELETE audit_events 被拒绝
  - [x] SubTask 4.4: README：补齐 /audit/verify 使用说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 1, Task 2, Task 3
