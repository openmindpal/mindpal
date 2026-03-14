# 本机执行端注册与配对（Device Runtime Enrollment）V1 Spec

## Why
《架构设计.md》3.1.2 指出本机执行端（Device Runtime / Device Agent）是端侧能力接入的可选扩展，但其安全与治理边界必须从第一天通过契约固化：设备注册/撤销可审计、最小权限由策略包络表达、设备仅能在受控链路下与平台交互。当前系统缺少 DeviceRecord/DevicePolicy 以及“配对/心跳/撤销”的最小闭环，导致无法安全引入端侧能力。

## What Changes
- 新增 DeviceRecord（V1）：
  - 记录设备身份、归属与在线状态
- 新增配对码（V1）：
  - 用户侧生成一次性配对码，设备侧用配对码完成 claim 并获得 deviceToken
- 新增 DevicePolicy（V1）：
  - 以结构化策略表达 device 能力包络（工具白名单/文件策略/出站策略/限制）
- 新增 Device API（V1）：
  - 管理侧：创建/列表/详情/生成配对码/撤销
  - 设备侧：pair、heartbeat
- 审计对齐（V1）：
  - 设备注册、配对、心跳、撤销均写审计（仅摘要，不包含敏感 token/code 明文）

## Impact
- Affected specs:
  - 统一请求链路（设备侧也必须走鉴权/审计）
  - 安全中枢（配对码与 token 只存摘要/密文）
  - 审计域（设备生命周期可追溯）
  - Skill Runtime（V2：设备执行请求/结果对齐）
- Affected code:
  - DB：新增 device_records/device_pairings/device_policies（或等价）迁移
  - API：新增 /devices 与 /device-agent 路由

## ADDED Requirements

### Requirement: DeviceRecord（V1）
系统 SHALL 支持 DeviceRecord 的最小管理：
- 字段（V1）：
  - deviceId（UUID）
  - tenantId
  - ownerScope（user|space）
  - ownerSubjectId（当 ownerScope=user）
  - spaceId（当 ownerScope=space）
  - deviceType（desktop|mobile）
  - os（string）
  - agentVersion（string）
  - status（pending|active|revoked）
  - enrolledAt、lastSeenAt

#### Scenario: 创建 DeviceRecord
- **WHEN** 用户创建 DeviceRecord
- **THEN** 返回 deviceId 且 status=pending
- **AND** 写审计（resourceType=device, action=create）

### Requirement: 一次性配对码（V1）
系统 SHALL 支持一次性配对码：
- 管理侧为指定 deviceId 生成 pairingCode
- pairingCode MUST 高熵随机且有 TTL（例如 10 分钟）
- pairingCode MUST 单次使用（被设备 claim 后标记 consumed）
- 存储时 pairingCode MUST 只存 hash（不存明文）

#### Scenario: 生成配对码
- **WHEN** 用户为 pending device 生成配对码
- **THEN** 返回 pairingCode（仅返回一次）
- **AND** 审计记录包含 pairingCodeDigest（不含明文）

### Requirement: 设备侧配对与 deviceToken（V1）
系统 SHALL 支持设备侧完成配对：
- 设备调用 `POST /device-agent/pair` 提交 pairingCode 与设备信息
- 系统校验 pairingCode 未过期且未使用，且绑定的 tenant/owner 不越权
- 成功后将 device.status 置为 active，并返回 deviceToken
- deviceToken MUST 只返回一次且服务端只存 hash（不存明文）

约束（V1）：
- 设备侧后续请求使用 `Authorization: Device <deviceToken>` 鉴权
- deviceToken 不可用于用户侧 API（仅限 /device-agent/*）

#### Scenario: 配对成功
- **WHEN** 设备提交正确 pairingCode
- **THEN** device.status=active 且返回 deviceToken
- **AND** 写审计（resourceType=device, action=pair）

#### Scenario: 配对失败
- **WHEN** pairingCode 无效/过期/已使用
- **THEN** 返回 400（稳定 errorCode）
- **AND** 写审计拒绝摘要

### Requirement: 设备心跳（V1）
系统 SHALL 支持设备上报心跳：
- `POST /device-agent/heartbeat`
- 使用 deviceToken 鉴权
- 更新 device.lastSeenAt 与 agentVersion/os（允许更新）
- 写审计（resourceType=device, action=heartbeat，输出仅摘要）

#### Scenario: 心跳更新在线
- **WHEN** active device 上报 heartbeat
- **THEN** lastSeenAt 更新
- **AND** 可被管理侧查询到

### Requirement: DevicePolicy（V1）
系统 SHALL 支持为 device 绑定一个结构化策略包络：
- 字段（V1）：
  - deviceId
  - allowedTools（string[] 可选）
  - filePolicy（allowedRoots、read/write）
  - networkPolicy（allowedDomains）
  - limits（timeoutMs、maxConcurrency）

约束（V1）：
- policy 变更必须写审计（resourceType=device, action=policy.update）

### Requirement: 撤销设备（V1）
系统 SHALL 支持撤销设备：
- 撤销后 device.status=revoked，deviceToken 立即失效
- 写审计（resourceType=device, action=revoke）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

