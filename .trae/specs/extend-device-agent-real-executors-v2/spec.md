# Device Agent Real Executors（文件/浏览器/桌面）V2 Spec

## Why
当前 `apps/device-agent` 的端侧执行器只支持 `noop/echo`，其余工具直接 `unsupported_tool`，满足 V1 “端到端闭环验证”但无法承载真实端侧任务。为了让 Device Runtime 真正可用，同时不破坏《架构设计.md》“默认拒绝 + 最小权限 + 可审计”的平台不变式，需要把端侧能力扩展为**受控的、契约化的**执行器集合（文件/浏览器/桌面自动化），并用 DevicePolicy 将能力包络固化到可验证约束里。

## What Changes
- 扩展 DevicePolicy（V2）
  - 增加 `uiPolicy`（桌面自动化能力包络）与 `evidencePolicy`（证据上传与保留期/类型）
  - 强化 `filePolicy/networkPolicy/limits` 的契约语义与默认值（默认拒绝）
- 端侧执行器扩展（V2）
  - 新增内置执行器：`device.file.*`（真实文件能力）、`device.browser.*`（浏览器自动化）、`device.desktop.*`（桌面自动化最小集合）
  - 端侧执行必须二次校验：对每次执行基于 DevicePolicy 做本机侧强约束（即使平台侧已校验）
- 平台侧校验与下发（V2）
  - `POST /device-executions` 对 device 工具入参做 JSON Schema 校验（复用 tool inputSchema）
  - 设备侧 `claim` 返回中携带执行所需的 **effective policy snapshot digest**（最小字段、可审计），用于端侧强制执行与回放解释
- 证据能力（V2，最小可用）
  - 允许设备侧上传“证据产物”（截图/文本/JSON 摘要）并返回 `evidenceRefs` 指向 artifact（受权限控制、短期下载 token）

## Impact
- Affected specs:
  - Device Runtime Enrollment/Execution（DevicePolicy 包络更完整）
  - Tools/Workflow/Audit（端侧工具也必须具备契约、幂等与审计摘要）
  - Media/Artifacts（端侧证据作为受控产物进入平台）
- Affected code:
  - API：device policies、device executions、artifacts upload（device token scope）
  - Device Agent：新增执行器实现与本机策略校验
  - DB：device_policies 增加 ui_policy/evidence_policy 等字段（如不存在）

## ADDED Requirements

### Requirement: 端侧工具命名空间（V2）
系统 SHALL 将“端侧真实能力”收敛到明确命名空间：
- 文件：`device.file.*`
- 浏览器：`device.browser.*`
- 桌面：`device.desktop.*`

约束（V2）：
- DeviceExecution 仅允许下发 `toolRef` 指向已发布（released）的工具版本
- device 侧仅实现/执行上述命名空间内的内置工具；其他 toolRef 一律拒绝（稳定错误码）

### Requirement: DevicePolicy 能力包络（V2）
系统 SHALL 支持以下 DevicePolicy 字段，并以默认拒绝为原则：
- `allowedTools: string[]`（工具白名单，按 toolName）
- `filePolicy`（文件能力包络）
  - `allowedRoots: string[]`（绝对路径前缀白名单）
  - `allowRead: boolean`
  - `allowWrite: boolean`
  - `maxBytesPerRead: number`
  - `maxBytesPerWrite: number`
- `networkPolicy`（出站治理）
  - `allowedDomains: string[]`
- `uiPolicy`（桌面自动化能力包络，V2 最小）
  - `allowedApps?: string[]`（可选；为空表示默认拒绝桌面自动化）
  - `allowClipboard?: boolean`
- `evidencePolicy`（证据策略）
  - `allowUpload: boolean`
  - `allowedTypes: string[]`（如 `image/png`, `application/json`, `text/plain`）
  - `retentionDays: number`（产物保留期）
- `limits`
  - `timeoutMs: number`
  - `maxConcurrency: number`

#### Scenario: 默认拒绝
- **WHEN** device 没有 policy 或 policy 中对应能力未显式放行
- **THEN** 相关端侧执行 MUST 被拒绝（稳定 errorCategory=`policy_violation`）

### Requirement: 执行入参校验（V2）
系统 SHALL 在两个位置执行入参校验：
- 平台侧：`POST /device-executions` 创建时根据工具版本 `inputSchema` 校验 `input`
- 端侧：device-agent 执行前再次根据本机执行器约束校验（含 filePolicy/networkPolicy/uiPolicy）

#### Scenario: 平台侧拒绝非法入参
- **WHEN** 创建 device execution 时 input 不符合 tool inputSchema
- **THEN** 返回稳定错误码 `INPUT_SCHEMA_INVALID`

### Requirement: 文件执行器（V2）
系统 SHALL 提供文件能力最小集合（V2）：
- `device.file.list@1`：列目录（返回条目元数据与摘要）
- `device.file.read@1`：读取文件（默认仅返回 digest/长度；若 `evidencePolicy.allowUpload=true` 且 requireUserPresence 通过，可上传内容为 artifact 并返回 evidenceRef）
- `device.file.write@1`：写入文件（必须 requireUserPresence=true；严格限制到 allowedRoots；写入输出仅摘要）

#### Scenario: filePolicy 约束生效
- **WHEN** 请求路径不在 `allowedRoots` 内
- **THEN** 端侧执行 MUST 失败且 `errorCategory=policy_violation`

### Requirement: 浏览器执行器（V2）
系统 SHALL 提供浏览器自动化最小集合（V2）：
- `device.browser.open@1`：打开/导航到 URL（仅允许 `networkPolicy.allowedDomains` 内的 host）
- `device.browser.screenshot@1`：截图并以 evidence artifact 形式回传（需 `evidencePolicy.allowUpload=true` 且 requireUserPresence=true）
- `device.browser.click@1`：点击（需 requireUserPresence=true；并在执行前展示可审计的 actionDigest 给用户确认）

约束（V2）：
- 浏览器执行器不得提供任意脚本执行接口
- 默认以“可留证 + 可撤销”优先；高风险动作必须 requireUserPresence

### Requirement: 桌面执行器（V2，最小集合）
系统 SHALL 支持桌面自动化的最小集合（V2），但必须显式开启：
- `device.desktop.launch@1`：启动允许列表内的应用（`uiPolicy.allowedApps`）
- `device.desktop.screenshot@1`：截屏作为证据（需 requireUserPresence=true）

### Requirement: 端侧证据上传（V2）
系统 SHALL 允许 device-agent 使用 deviceToken 上传证据产物：
- 上传内容进入 artifacts/media 体系，受 tenant/space 权限控制
- 返回 `evidenceRefs` 可用于审计与回放定位（不包含原文敏感数据）

#### Scenario: 证据上传受控
- **WHEN** `evidencePolicy.allowUpload=false`
- **THEN** 任何证据上传请求 MUST 被拒绝（稳定错误码）

## MODIFIED Requirements

### Requirement: Device Agent 执行器集合（从 V1 到 V2）
系统 SHALL 保留 V1 `noop/echo` 作为连通性工具，但在 V2 增加真实端侧能力执行器，并确保：
- 每次执行都绑定 `toolRef + policySnapshotRef + idempotencyKey` 并写审计摘要
- 端侧执行失败具有稳定 `errorCategory` 与 `outputDigest`（不泄露敏感明文）

## REMOVED Requirements
（无）

