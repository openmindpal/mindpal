# Device Agent Runtime（桌面端）V1 Spec

## Why
平台侧已具备 Device Runtime 的注册/配对、心跳与 DeviceExecution（下发/领取/回传）闭环，但仍缺“真实端侧 Agent”。按《架构设计.md》3.1.2，本机执行端需要把设备能力收敛为受控执行：仍遵守统一链路（鉴权→校验→授权→执行→审计），并在设备侧提供最小权限与本机确认闸门。

## What Changes
- 新增桌面端 Device Agent（V1，Node/TS CLI 形态）
  - pairing：使用一次性 pairingCode 换取 deviceToken，并本地持久化
  - heartbeat：定时上报心跳（agentVersion/os/deviceType）
  - execution：轮询 pending → claim → 本地执行（V1 先提供可控的“内置执行器”集合）→ result 回传
- 本机确认闸门（V1）
  - 当 `requireUserPresence=true` 时，执行前强制本机确认（CLI 交互）
- 安全与约束（V1）
  - deviceToken 仅落本机配置文件，不输出到日志
  - 仅允许访问 API_BASE（不做任意出站）
  - evidenceRefs 仅回传引用（V1 以本地文件 hash/路径脱敏为主，不上传内容）

## Impact
- Affected specs:
  - Device Runtime：Enrollment/Execution 从“平台侧 API”升级为“端侧可运行”
  - Execution Plane：端侧执行与回传成为可运营的持续运行入口
  - Safety/DLP：端侧日志与回传摘要遵循脱敏规范
- Affected code:
  - 新增 `apps/device-agent`（Node/TS CLI）
  - （可选）扩展 API：为端侧提供轻量健康检查/版本协商（若需要）

## ADDED Requirements

### Requirement: Device Agent CLI（V1）
系统 SHALL 提供一个可在桌面端运行的 Device Agent（V1）：
- 启动模式：
  - `device-agent pair --pairingCode <code>`
  - `device-agent run`（常驻：heartbeat + execution loop）
- 本机配置（V1）：
  - 保存 `{ apiBase, deviceToken, deviceId, enrolledAt, agentVersion, os, deviceType }`
  - 配置文件路径默认在用户目录（平台不写死到仓库路径）

#### Scenario: Pairing 成功
- **WHEN** 用户运行 `device-agent pair` 并提供有效的 pairingCode
- **THEN** Agent 调用 `POST /device-agent/pair` 获取 deviceToken
- **AND** 将 token 持久化到本机配置
- **AND** 输出中不显示 token 明文

### Requirement: Heartbeat Loop（V1）
系统 SHALL 定期上报心跳：
- **WHEN** Agent 进入 run 模式
- **THEN** 每 `heartbeatIntervalSec` 调用 `POST /device-agent/heartbeat`
- **AND** 若 4xx（鉴权失败/撤销）则停止循环并进入需要重新配对状态

### Requirement: Execution Loop（V1）
系统 SHALL 执行设备侧 execution 协议：
- **WHEN** Agent 处于 run 模式
- **THEN** 周期性调用 `GET /device-agent/executions/pending?limit=N`
- **AND** 对每条 pending：
  - 先 `POST /device-agent/executions/:id/claim`
  - 再执行本地动作（V1 执行器集合）
  - 最后 `POST /device-agent/executions/:id/result`

V1 执行器集合（最小可用）：
- `noop`：直接返回 succeeded（用于端到端连通性验证）
- `echo`：回传输入摘要（不回传敏感字段明文）

### Requirement: 本机确认闸门（V1）
系统 SHALL 在需要用户在场的执行上强制确认：
- **WHEN** claim 响应里包含 `requireUserPresence=true`
- **THEN** Agent MUST 阻塞等待用户明确确认后再执行
- **AND** 若用户拒绝或超时，Agent MUST 回传 `failed` 并将 errorCategory 标记为 `user_denied`

### Requirement: 最小权限与出站约束（V1）
系统 SHALL 遵守最小权限与出站约束：
- Agent 仅向 `apiBase` 发起请求，不执行任意外部网络访问
- 日志不得包含 deviceToken、refresh_token、access_token 等敏感明文

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

