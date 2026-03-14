# Tasks
- [x] Task 1: 为 IMAP 入站事件扩展 mediaRef payload
  - [x] SubTask 1.1: 定义 ingress payload 最小结构（body/attachments + 摘要字段）
  - [x] SubTask 1.2: 确认 eventId 幂等判断点（先查/先插入）与写入顺序

- [x] Task 2: Worker：IMAP poller 落地正文/附件为 MediaObject
  - [x] SubTask 2.1: 提取正文与附件字节（MVP：仅支持文本正文与常见附件）
  - [x] SubTask 2.2: 应用大小护栏（单附件/总量），超限仅写摘要不写 mediaRef
  - [x] SubTask 2.3: 创建 MediaObject 并回填 ingress payload 的 mediaRef

- [x] Task 3: 审计对齐与安全护栏
  - [x] SubTask 3.1: poll 审计输出仅摘要与 mediaRef（禁止写入内容字节）
  - [x] SubTask 3.2: 验证 space 隔离与 tenant 隔离不被绕过

- [x] Task 4: 回归测试
  - [x] SubTask 4.1: e2e 或 worker 测试：重复拉取不重复创建 MediaObject
  - [x] SubTask 4.2: e2e：audit 可按 traceId 检索且不泄露正文/附件内容
  - [x] SubTask 4.3: 超限附件行为覆盖（无 mediaRef 但有摘要）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2, Task 3
