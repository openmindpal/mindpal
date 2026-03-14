# Orchestrator 控制台演示页（建议→确认→执行）V1 Spec

## Why
后端已具备 `/orchestrator/turn`（生成建议）与 `/orchestrator/execute`（受控执行闭环），但控制台缺少可视化入口来查看建议、修改入参并确认执行，导致编排链路难以自测、难以演示，也不利于按《架构-08》做“人类确认 → 受控执行”的默认交互。

## What Changes
- 新增 Console 页面：Orchestrator 演示页（V1）
  - 输入自然语言 → 调用 `/orchestrator/turn` → 展示 replyText、uiDirective、toolSuggestions
  - 对 toolSuggestion 提供“编辑入参 + 确认执行”→ 调用 `/orchestrator/execute`
  - 展示执行回执（queued/needs_approval），并提供跳转到审批详情或 run 详情
- i18n 与质量门槛（V1）
  - TS/TSX 不直接写中文；新增 locales keys（zh-CN/en-US）
  - 控制台 e2e 覆盖基本链路：turn + execute（queued 或 needs_approval）

## Impact
- Affected specs:
  - 交互平面（控制台 UI）
  - AI 编排层（建议与执行闭环的可用性）
  - 工作流与自动化（审批分流在 UI 中可见）
- Affected code:
  - Web：新增页面与组件；ConsoleShell 增加导航入口
  - Web e2e：扩展 console e2e 脚本覆盖 Orchestrator 演示页

## ADDED Requirements

### Requirement: Orchestrator 演示页（V1）
系统 SHALL 在 Console 提供 Orchestrator 演示页：
- 页面包含：消息输入框、发送按钮、响应展示区域、建议列表区域

#### Scenario: 生成建议
- **WHEN** 用户在演示页提交 message
- **THEN** 前端调用 `POST /orchestrator/turn`
- **AND** 展示 replyText
- **AND** 展示 uiDirective（若存在）
- **AND** 展示 toolSuggestions 列表（若存在）

#### Scenario: 确认执行建议
- **WHEN** 用户点击某条 toolSuggestion 的“执行”
- **THEN** 前端允许用户编辑 input（JSON）与可选的 idempotencyKey
- **AND** 调用 `POST /orchestrator/execute`
- **AND** 展示 receipt 与 correlation（含 runId/stepId/approvalId?）
- **AND** 若 needs_approval，则提供进入审批页的跳转入口
- **AND** 若 queued，则提供进入执行中心 run 详情页的跳转入口

#### Scenario: 入参非法
- **WHEN** `/orchestrator/execute` 返回 400/403/404
- **THEN** 前端展示 errorCode/message/traceId（不吞错）

### Requirement: UI 指令呈现（V1）
- **WHEN** orchestrator 返回 uiDirective
- **THEN** 前端以只读方式展示其结构化内容（openView/openMode/viewParams）
- **AND** 若 openView=page 且 viewParams.name 存在，则提供“打开页面”快捷跳转

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

