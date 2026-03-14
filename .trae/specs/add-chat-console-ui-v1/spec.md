# 对话控制台（类 CoPaw）界面 Spec

## Why
当前 Web（http://localhost:3000/）以管理台与治理控制台为主，已有 Orchestrator Playground 但仍偏“单次请求/响应”演示，不是连续对话形态。为了让用户能像 CoPaw 一样以对话驱动编排与工具执行，需要一个更贴近日常使用的对话界面。

## What Changes
- 新增 Web 路由：提供一个“对话/Chat”页面（独立于现有 Home 与 Orchestrator Playground），以聊天时间线方式展示多轮消息。
- 前端在本地维护会话状态（消息列表、当前 turn 状态、最近一次 toolSuggestions），不要求后端新增会话存储。
- 接入现有 API：
  - `POST /orchestrator/turn`：发送用户消息，渲染 assistant 回复、uiDirective、toolSuggestions
  - `POST /orchestrator/execute`：对某条 toolSuggestion 发起执行，渲染 receipt，并提供跳转（run/approval 等）
- 将 toolSuggestions 以“可操作卡片/消息块”渲染在对话流中（包含风险、是否需要审批、idempotencyKey、输入草稿预览与编辑）。
- 导航入口：在现有 Web 导航（Home/ConsoleShell/AppShell 体系）新增入口指向对话页面；Home 页可选增加 CTA 链接。
- i18n：新增对话页面涉及的文案 key，保持 TS/TSX 无中文。
- 测试：补充 Web e2e 覆盖“发送一轮 turn + 执行一条 suggestion（得到 queued 或 needs_approval）”。

## Impact
- Affected specs: Orchestrator Playground（能力复用但不替换）、Web Console UI、一致的错误展示与跳转能力
- Affected code:
  - Web：`apps/web/src/app/**`（新增页面路由与 UI）
  - Web：`apps/web/src/lib/api.ts`（复用 header/token 逻辑；不强制修改）
  - API：无新增接口（仅消费既有 `orchestrator` 路由）

## ADDED Requirements
### Requirement: Chat UI Page
系统 SHALL 提供一个对话式页面，用于发送消息并以时间线展示多轮交互结果。

#### Scenario: 发送消息（Success）
- **WHEN** 用户在对话页面输入消息并点击发送
- **THEN** 页面将该消息作为 user 消息追加到对话流
- **AND** 调用 `POST /orchestrator/turn`
- **AND** 将返回的 `replyText` 作为 assistant 消息追加到对话流
- **AND** 若返回包含 `uiDirective/toolSuggestions`，则以可视化块展示在同一轮 assistant 结果下

#### Scenario: 发送消息失败（Error）
- **WHEN** `POST /orchestrator/turn` 返回非 2xx 或响应不可解析
- **THEN** 页面将错误以 assistant 错误消息块展示
- **AND** 错误信息包含 `errorCode/message/traceId`（如存在）

### Requirement: Tool Suggestion Execute
系统 SHALL 允许用户在对话页面对 toolSuggestions 发起确认执行，并将结果写入对话流。

#### Scenario: 执行建议（Success）
- **WHEN** 用户在某条 suggestion 上打开执行面板并确认执行
- **THEN** 页面调用 `POST /orchestrator/execute`
- **AND** 将返回结果（`receipt.status`、`runId/approvalId/stepId` 等）以 assistant 消息块追加到对话流
- **AND** 若包含 `runId/approvalId`，页面提供可点击跳转

#### Scenario: 执行建议失败（Error）
- **WHEN** `POST /orchestrator/execute` 返回非 2xx
- **THEN** 页面以同一条 suggestion 的错误状态呈现错误信息（含 `errorCode/message/traceId`）

## MODIFIED Requirements
### Requirement: Web 导航入口
系统 SHALL 在 Web 导航中提供进入“对话/Chat”页面的入口，不影响现有页面路由与权限保护逻辑。

## REMOVED Requirements
无

