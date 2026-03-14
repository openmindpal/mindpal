# 执行中心回放视图 UI（V1）Spec

## Why
当前系统已具备 Run/Step 与 `/runs/:runId/replay` 回放接口，但 Web 的“执行中心”只展示 run/steps 摘要，缺少可解释的时间线回放视图，无法支撑《架构设计》与《架构-08》要求的“可审计、可回放、可追溯”的运营闭环。

## What Changes
- Web 执行中心 Run 详情页新增“回放（Replay）”区块：
  - 调用 `GET /runs/:runId/replay` 加载回放视图
  - 展示 timeline 事件列表（timestamp/eventType/runId/stepId/result/errorCategory/traceId/requestId 等摘要字段）
  - 支持复制/展开查看单条事件的 JSON（仅摘要，不展示敏感原文）
- 与审计联动（V1）：
  - 在回放区块中展示 traceId，并提供跳转到治理控制台审计页的入口（仅导航，不改变权限与范围）
- i18n（默认中文）：
  - 补齐回放区块的中英文文案 key
- 质量门槛：
  - 扩展 Web e2e-console-mode：确保执行中心与回放视图在 simple/governance 模式下均可加载

## Impact
- Affected specs:
  - 交互平面（执行中心定制页面）
  - 工作流回放（Replay）V1（消费既有回放 API）
  - 审计域（traceId 可追溯）
- Affected code:
  - Web：Run 详情页组件与 i18n 资源
  - Web e2e：`apps/web/scripts/e2e-console-mode.mjs`
  - API：无新增接口（复用既有 `/runs/:runId/replay`）

## ADDED Requirements

### Requirement: Run 回放视图（V1）
系统 SHALL 在 Web 的 Run 详情页提供回放视图区块。

#### Scenario: 加载回放成功
- **WHEN** 用户在 Run 详情页触发“加载回放”
- **THEN** 前端调用 `GET /runs/:runId/replay` 并渲染回放摘要
- **AND** 展示 timeline 列表（按时间排序）
- **AND** 每条 timeline 至少展示 timestamp 与 eventType

#### Scenario: 回放加载失败可诊断
- **WHEN** 回放接口返回非 2xx
- **THEN** 页面展示错误信息（包含 errorCode/message/traceId 或等价可诊断字段）

### Requirement: 回放与审计联动（V1）
系统 SHALL 在回放视图中展示 traceId，并提供“查看审计”入口跳转至治理审计页（仅 URL 导航）。

#### Scenario: 非治理模式下行为
- **WHEN** 用户处于简易模式（simple）
- **THEN** “查看审计”入口可隐藏或显示但不影响加载回放（两者均可接受）

## MODIFIED Requirements

### Requirement: 执行中心 Run 详情页（V1）
系统 SHALL 在 Run 详情页除 run/steps 摘要外，增加“回放（Replay）”区块，用于展示可解释执行轨迹。

## REMOVED Requirements
（无）
