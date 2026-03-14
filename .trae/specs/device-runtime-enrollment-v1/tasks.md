# Tasks
- [x] Task 1: Device 表结构与 repo
  - [x] SubTask 1.1: 新增 migrations：device_records/device_pairings/device_policies（含索引与 TTL 字段）
  - [x] SubTask 1.2: 实现 deviceRepo（create/get/list/updateStatus/updateLastSeen/revoke）
  - [x] SubTask 1.3: 实现 pairingRepo（create/consume/expire 校验，code 只存 hash）
  - [x] SubTask 1.4: 实现 devicePolicyRepo（get/upsert）

- [x] Task 2: 管理侧 /devices API
  - [x] SubTask 2.1: `POST /devices` 创建 pending device
  - [x] SubTask 2.2: `GET /devices` 列表（分页/limit）
  - [x] SubTask 2.3: `GET /devices/:deviceId` 详情（含 policy）
  - [x] SubTask 2.4: `POST /devices/:deviceId/pairing` 生成一次性配对码
  - [x] SubTask 2.5: `POST /devices/:deviceId/revoke` 撤销设备
  - [x] SubTask 2.6: `PUT /devices/:deviceId/policy` 更新 device policy

- [x] Task 3: 设备侧 /device-agent API
  - [x] SubTask 3.1: `POST /device-agent/pair`（配对码 claim，返回 deviceToken）
  - [x] SubTask 3.2: `POST /device-agent/heartbeat`（deviceToken 鉴权）

- [x] Task 4: 鉴权、审计与回归
  - [x] SubTask 4.1: 设备鉴权 middleware（Authorization: Device <token>）
  - [x] SubTask 4.2: 所有 device 生命周期动作写审计（仅摘要，不含明文 code/token）
  - [x] SubTask 4.3: e2e：创建 device→生成配对码→pair→heartbeat→revoke
  - [x] SubTask 4.4: e2e：配对码过期/重复使用/越权拒绝
  - [x] SubTask 4.5: README：补齐 Device Runtime Enrollment V1 用法

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2 and Task 3
