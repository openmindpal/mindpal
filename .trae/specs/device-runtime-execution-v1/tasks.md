# Tasks
- [x] Task 1: DeviceExecution 数据模型与存储
  - [x] SubTask 1.1: 新增 migrations：device_executions 表、索引（tenant/device/status/createdAt）
  - [x] SubTask 1.2: 实现 deviceExecutionRepo（create/get/list/cancel/claim/complete）

- [x] Task 2: 管理侧 /device-executions API
  - [x] SubTask 2.1: `POST /device-executions`（校验 toolRef 已发布，写审计）
  - [x] SubTask 2.2: `GET /device-executions`（分页/过滤）
  - [x] SubTask 2.3: `GET /device-executions/:id`（详情）
  - [x] SubTask 2.4: `POST /device-executions/:id/cancel`（状态机校验）

- [x] Task 3: 设备侧领取与回传 API
  - [x] SubTask 3.1: `GET /device-agent/executions/pending`（仅返回本 device）
  - [x] SubTask 3.2: `POST /device-agent/executions/:id/claim`（原子 claim + policy.allowedTools 校验）
  - [x] SubTask 3.3: `POST /device-agent/executions/:id/result`（写入 outputDigest/evidenceRefs）

- [x] Task 4: 鉴权、审计与回归
  - [x] SubTask 4.1: 设备 token 鉴权复用 Enrollment 逻辑（Authorization: Device）
  - [x] SubTask 4.2: create/claim/result/cancel 全链路写审计（仅摘要，不含敏感明文）
  - [x] SubTask 4.3: e2e：创建 execution→设备 pending/claim→result→管理侧可查
  - [x] SubTask 4.4: e2e：跨 device/跨 space 越权拒绝；allowedTools 拒绝
  - [x] SubTask 4.5: README：补齐 Device Execution V1 用法

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2 and Task 3
