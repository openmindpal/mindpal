# Tasks
- [x] Task 1: 定义端侧工具契约与发布方式（device.file/device.browser/device.desktop）
  - [x] SubTask 1.1: 为每个端侧工具补齐 tool definition（scope/resourceType/action/risk/idempotency/inputSchema/outputSchema）
  - [x] SubTask 1.2: 为 device 执行路径加入 inputSchema 校验（创建 execution 时校验）

- [x] Task 2: 扩展 DevicePolicy（uiPolicy/evidencePolicy）并做平台侧/端侧强制执行
  - [x] SubTask 2.1: DB 迁移与 repo 扩展（device_policies 新字段）
  - [x] SubTask 2.2: claim 响应携带 effective policy digest（最小字段，不含敏感明文）
  - [x] SubTask 2.3: device-agent 执行前强制校验 filePolicy/networkPolicy/uiPolicy/limits

- [x] Task 3: 实现 device-agent 真实执行器（V2 最小集合）
  - [x] SubTask 3.1: device.file.list/read/write（含 allowedRoots 与 requireUserPresence 约束）
  - [x] SubTask 3.2: device.browser.open/click/screenshot（含 allowedDomains 与禁任意脚本）
  - [x] SubTask 3.3: device.desktop.launch/screenshot（Windows 最小可用；必须 allowlist）

- [x] Task 4: 证据上传（device token scope）与 evidenceRefs 闭环
  - [x] SubTask 4.1: 提供 device-agent 证据上传 API（受 evidencePolicy 控制）
  - [x] SubTask 4.2: 在 device-agent 执行结果中返回 evidenceRefs（指向 artifactId 或短期下载 token）

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API e2e：device.file.* 的 policy 拒绝/放行与审计摘要
  - [x] SubTask 5.2: API e2e：device.browser.* 的 allowedDomains 与 requireUserPresence
  - [x] SubTask 5.3: device-agent 集成测试：执行器成功/拒绝/证据上传（不泄露敏感）

# Task Dependencies
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 1, Task 2, Task 3, Task 4
