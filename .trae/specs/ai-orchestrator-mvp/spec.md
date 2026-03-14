# AI 编排层（受控工具调用 + UI 指令）MVP Spec

## Why
当前平台已具备 Tool Registry、Workflow/Queue、审计与配置驱动 UI，但缺少“把用户意图转化为受控工具/流程调用”的编排入口，无法形成《架构设计.md》与《架构-08-AI编排层-受控工具调用与回放.md》要求的对话驱动闭环。

## What Changes
- 新增 Orchestrator API：接收用户输入，返回结构化回执（replyText/toolSuggestions/uiDirective）
- 新增工具建议策略（MVP）：基于已发布 Tool Registry + 简单规则/关键词匹配生成候选工具与入参草稿
- 新增工具入参/出参契约校验（MVP 子集）：对 toolRef 的 inputSchema/outputSchema 进行最小校验，避免旁路执行
- 新增 uiDirective（OpenView + ViewParams）回执：用于引导前端打开与意图最相关的页面（仅导航建议，不改变权限）
- Orchestrator 全链路审计：记录决策摘要、候选工具、uiDirective、traceId

## Impact
- Affected specs:
  - AI 编排层（受控工具调用与回放）
  - 交互平面（对话驱动导航 uiDirective）
  - 工具注册表与受控执行（toolRef、input/output 校验）
  - 审计域（新增 orchestrator 事件类型）
- Affected code:
  - API：新增 /orchestrator/* 路由与编排模块
  - Web（可选）：提供最小 UI 示例以消费 uiDirective（MVP 可仅返回结构并在后续接入）

## ADDED Requirements

### Requirement: Orchestrator 回执契约（MVP）
系统 SHALL 提供 Orchestrator API，接受用户输入并返回结构化回执：
- replyText：面向用户的文本回复（按 locale/默认中文）
- toolSuggestions：建议的工具候选列表（包含 toolRef、inputDraft、riskLevel、approvalRequired）
- uiDirective：建议性 UI 指令（openView/viewParams/openMode）

#### Scenario: 生成工具建议
- **WHEN** 用户提出“新建笔记/创建记录”等意图
- **THEN** Orchestrator 返回包含 `entity.create@<version>` 的 toolSuggestions
- **AND** inputDraft 至少包含 entityName/payload 的最小草稿结构

#### Scenario: 生成 UI 指令
- **WHEN** 用户提出“打开/查看某实体列表”等意图
- **THEN** Orchestrator 返回 uiDirective，指向可用页面（例如已发布 PageTemplate 的 name）
- **AND** uiDirective 为建议性指令，前端必须白名单与权限校验

### Requirement: 工具契约校验（MVP 子集）
系统 SHALL 对 Orchestrator 产出的 toolRef 与 inputDraft 做最小校验：
- toolRef 必须存在且 status=released
- inputDraft 必须满足 toolVersion.inputSchema 的最小字段要求（字段存在/必填/类型子集）

#### Scenario: 非法工具引用
- **WHEN** Orchestrator 输出未发布或不存在的 toolRef
- **THEN** 系统拒绝返回该建议（或标记为 invalid），并写审计

### Requirement: Orchestrator 审计（MVP）
系统 SHALL 对每次 Orchestrator 调用写审计事件，至少包含：
- resourceType=orchestrator，action=turn
- traceId、subject、tenant/space
- 决策摘要（候选工具列表、uiDirective 摘要）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

