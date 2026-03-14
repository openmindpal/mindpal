# 多聊天渠道接入（DingTalk/QQ/企业微信/Slack/Discord/iMessage/飞书）Spec

## Why

当前系统已有通用的 channels ingress/outbox 能力，但仍需要“开箱即用”的多 IM 渠道适配与配置闭环，才能接近 CoPaw 的“一个助手接多个聊天应用”的体验。

## What Changes

* 新增“渠道 Provider 适配层”：为不同 IM 渠道提供入站验签、事件解析与统一消息 Envelope 归一化能力。

* 新增“渠道 Workspace 配置”与“Bot 凭据”治理接口与 UI：可在 Console 中完成配置、映射与连通性验证。

* 为 Outbox 增加可选的“服务端直投递”能力：支持各 Provider 的发送 API（或桥接服务），减少外部轮询依赖。

* 新增接入文档与 e2e 覆盖：覆盖所有目标 Provider 的端到端链路（本地模拟为主，必要时使用桥接模拟）。

## Impact

* Affected specs:

  * channel-ingress-gateway-mvp（复用：幂等去重、审计、subject 映射、同步/异步回执）

  * channel-im-adapter-mvp（复用：outbox 模型、回执投递语义）

* Affected code:

  * API：channels 路由、channels repo、治理侧 channels 管理接口、（可选）投递 runner/订阅 runner

  * Web：新增治理页面（channels hub）与导航/文案

## ADDED Requirements

### Requirement: Channel Provider Adapter

系统 SHALL 支持按 provider 注册“入站适配器”，将 provider 原生 webhook/回调解析为统一的 Channel Envelope，并复用现有幂等去重与审计链路。

#### Scenario: 入站成功（同步模式）

* **WHEN** 渠道 provider 的 webhook 请求到达对应的 provider endpoint

* **AND** 验签通过且未命中去重

* **AND** 能通过 ChannelAccount/ChatBinding 映射到 tenant/space/subject

* **THEN** 系统调用 orchestrator turn 并返回标准回执

* **AND** 写入 ingress\_events/outbox/audit 记录（不泄露任何密钥/凭据）

#### Scenario: 入站拒绝（验签失败/重放/映射缺失）

* **WHEN** 验签失败或超出容忍窗口或 nonce 重放

* **THEN** 系统 SHALL 返回拒绝响应并记录审计（errorCategory=policy\_violation）

* **WHEN** subject 映射缺失

* **THEN** 系统 SHALL 返回 403 并记录审计（errorCategory=policy\_violation）

### Requirement: Channel Workspace 配置与凭据管理

系统 SHALL 提供治理接口与 UI 用于管理每个 provider/workspace 的 webhook 配置与 bot 凭据引用。

#### Scenario: 控制台配置

* **WHEN** 管理员在 Console 中选择 provider 并填写 workspaceId、回调 URL、签名密钥/凭据引用

* **THEN** 系统保存配置并展示“接入指引”（包括回调 URL、需要在渠道侧填写的字段）

### Requirement: Outbox 服务端直投递（MVP）

系统 SHALL 支持对至少一个 provider 进行 outbox 消息服务端投递（无需外部 poll/ack），并在投递成功/失败时更新 outbox 状态与审计。

#### Scenario: 投递成功

* **WHEN** outbox 中存在待投递消息且 provider 配置完整

* **THEN** 系统向 provider 的发送 API 发起请求并将 outbox 标记为 delivered/acked

#### Scenario: 投递失败可重试

* **WHEN** provider 返回可重试错误（如 429/5xx）

* **THEN** 系统 SHALL 按既定 backoff 策略重试并记录尝试次数

### Requirement: 全量 Provider 覆盖（DingTalk/QQ/企业微信/Slack/Discord/iMessage/飞书）

系统 SHALL 提供以下 Provider 的“入站 + 出站”接入能力，并可在 Console 中完成配置、映射与连通性验证：

* 飞书（Feishu）：官方事件回调 + 官方发送 API

* 钉钉（DingTalk）：官方回调 + 官方发送 API

* 企业微信（WeCom）：官方回调 + 官方发送 API

* Slack：Events API + Web API（chat.postMessage）

* Discord：Interactions/Webhook + Bot/REST（或 Webhook 发送）

* QQ：通过 OneBot/第三方桥接服务接入（HTTP webhook/反向 WebSocket 二选一，MVP 可先做 HTTP）

* iMessage：通过桥接服务接入（HTTP webhook 形式，MVP 不要求直连 Apple 官方）

#### Scenario: Provider 选择与接入模式

* **WHEN** 管理员在 Console 选择任一 Provider 并创建 workspace 配置

* **THEN** 系统 SHALL 展示该 Provider 的“接入模式说明”（官方/桥接）与所需字段清单

* **AND** 系统 SHALL 支持对该 Provider 执行“连通性测试”（最小：校验凭据齐备；可选：调用 provider token/health 接口）

#### Scenario: 统一不变式适用

* **WHEN** 任一 Provider 的入站事件进入系统

* **THEN** 系统 SHALL 执行：验签/重放防护→幂等去重→subject 映射→AuthZ→turn→审计→回执

* **AND** 系统 SHALL 确保：审计与日志中不出现任何密钥/凭据/访问令牌明文

### Requirement: QQ / iMessage 桥接 Contract（固定协议）

系统 SHALL 为 QQ 与 iMessage 提供“桥接 Provider Contract”，以便在不依赖官方 API 的情况下稳定接入；桥接服务只负责协议转换与转发，平台侧仍负责验签/幂等/映射/授权/审计/回执。

#### Contract: 统一命名与标识

* Provider 名称：`qq.onebot` 与 `imessage.bridge`

* `workspaceId`：桥接服务的 workspace 维度（建议与桥接实例/账号绑定的唯一标识一致）

* `eventId`：桥接服务生成的全局唯一事件 id（同一入站事件重试必须保持不变）

* `nonce`：桥接服务生成的随机字符串（重试可复用原值）

* `timestampMs`：桥接服务发送请求时的毫秒时间戳

* `channelChatId`：会话/群聊/联系人维度的渠道侧唯一标识（QQ 群/私聊、iMessage 对话线程）

* `channelUserId`：发送者维度的渠道侧唯一标识（QQ 用户、iMessage 发送者）

* `bridgeMessageId`：桥接侧消息 id（用于定位原消息，可选）

#### Contract: 入站 Webhook（统一）

入站端点（建议）：

* `POST /channels/qq/bridge/events`（provider=`qq.onebot`）

* `POST /channels/imessage/bridge/events`（provider=`imessage.bridge`）

请求头（必需）：

* `content-type: application/json`

* `x-bridge-timestamp: <unix_ms>`

* `x-bridge-nonce: <string>`

* `x-bridge-signature: <hex>`（HMAC-SHA256）

验签输入（必须完全一致，禁止额外空格/换行差异）：

* `signingInput = "<timestampMs>.<nonce>.<eventId>.<bodyDigest>"`

* `bodyDigest = sha256Hex(stableJson(body))`

* `signature = hex(hmac_sha256(sharedSecret, signingInput))`

sharedSecret 来源：

* webhook config 的 `secretId` 或 `secretEnvKey` 二选一

  * `secretId`（推荐）：其 payload MUST 包含 `webhookSecret`

  * `secretEnvKey`：其 env value 作为 `webhookSecret`

重放防护：

* 平台 SHALL 校验 `abs(nowMs - timestampMs) <= toleranceSec * 1000`

* 平台 SHALL 以 `(provider, workspaceId, eventId)` 做幂等去重；重复事件返回之前已持久化的 response（若存在）

请求体（JSON，统一结构）：

```json
{
  "provider": "qq.onebot",
  "workspaceId": "bridge-1",
  "eventId": "evt_01H...",
  "timestampMs": 1710000000000,
  "nonce": "n_abc",
  "type": "message",
  "channelChatId": "chat_123",
  "channelUserId": "user_456",
  "bridgeMessageId": "msg_789",
  "text": "hello",
  "attachments": [
    { "kind": "image", "url": "https://...", "mime": "image/png", "name": "a.png", "size": 12345 }
  ],
  "raw": { "any": "provider specific payload" }
}
```

字段约束：

* `provider/workspaceId/eventId/type/timestampMs/nonce/channelChatId/channelUserId` MUST NOT 为空

* `type` 当前固定为 `message`（后续可扩展：`callback`/`system`）

* `text` 可为空（例如纯图片消息），但 `text` 与 `attachments` 至少其一存在

* `raw` 用于保留桥接原始事件，平台不做强依赖（用于排障与审计摘要）

响应体（JSON，统一结构）：

```json
{
  "correlation": { "requestId": "req-...", "traceId": "t-..." },
  "status": "received"
}
```

响应语义：

* 200：已处理完成或同步回执可返回 200

* 202：已入队（异步），并返回 `status=received/queued`

* 403：验签失败/重放/映射缺失等 policy\_violation

#### Contract: 出站 Send API（桥接服务，统一）

平台向桥接服务发送消息的统一接口（桥接服务实现）：

* `POST {bridgeBaseUrl}/v1/send`

请求头（必需）：

* `content-type: application/json`

* `x-bridge-timestamp: <unix_ms>`

* `x-bridge-nonce: <string>`

* `x-bridge-signature: <hex>`（HMAC-SHA256，同入站算法）

请求体（JSON，统一结构）：

```json
{
  "provider": "imessage.bridge",
  "workspaceId": "bridge-1",
  "requestId": "req-...",
  "traceId": "t-...",
  "to": { "channelChatId": "chat_123" },
  "message": { "text": "reply text" },
  "idempotencyKey": "outbox_<outboxId>"
}
```

响应体（JSON）：

```json
{
  "status": "ok",
  "bridgeMessageId": "msg_001",
  "providerMessageRef": "optional"
}
```

错误响应（JSON）：

```json
{
  "status": "error",
  "errorCode": "RETRYABLE",
  "message": "rate limited"
}
```

错误码约定：

* `RETRYABLE`：平台 SHALL 重试（例如 429/5xx/临时网络）

* `FATAL`：平台 SHALL 标记失败且不重试（例如参数不合法、鉴权失败）

平台 outbox 投递约定：

* 平台 SHALL 使用 `idempotencyKey` 保障桥接发送幂等

* 平台 SHALL 采用 backoff 重试策略，并记录 attempt 次数与审计摘要（不含凭据）

## MODIFIED Requirements

### Requirement: 通用 Webhook Ingress（兼容扩展）

现有 `/channels/webhook/ingress` SHALL 继续作为“统一入口/内部归一化后的入口”，并允许 provider 适配器复用该逻辑；新增的 provider endpoints 不应破坏其既有行为。

## REMOVED Requirements

无。

## Provider 范围（MVP 与后续）

* MVP SHALL 覆盖：飞书（已落地端到端）+ 钉钉 + 企业微信 + Slack + Discord（官方接口）+ QQ（OneBot 桥接）+ iMessage（桥接服务）。

* 对于 QQ/iMessage 等非官方直连 Provider，系统 SHALL 以“桥接 Provider”方式接入，并保证与官方 Provider 相同的不变式（验签/幂等/审计/授权）。

