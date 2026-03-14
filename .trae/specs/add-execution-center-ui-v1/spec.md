# 执行中心（Run/Step）与任务进度 UI V1 Spec

## Why
平台已具备 Workflow Run/Step、审计与审批等执行闭环能力，但缺少面向用户的“长任务中心”视图，导致执行过程不可见、不可运营、不可自助取消/重试，不符合《架构设计.md》对可解释进度与可取消入口的要求。

## What Changes
- Web 新增“执行中心”页面：Run 列表与 Run 详情（含 Step 列表、状态与错误摘要）
- Web 支持对进行中的 Run 自动刷新（轮询方式，MVP）
- API 补齐/对齐 Run 查询与操作接口（列表、详情、取消、重试），并确保全链路审计
- RBAC 对齐：Run/Step 的 read/cancel/retry 动作均受统一 AuthZ 决策保护
- i18n：Web 端新增相关文案 keys，满足 `check-no-zh`

## Impact
- Affected specs:
  - 工作流与自动化（Run/Step 生命周期与可运营）
  - 审计域（Run cancel/retry 事件）
  - 交互平面（长任务中心、可取消入口）
- Affected code:
  - API：/runs 列表与详情、/runs/:runId/cancel、/runs/:runId/retry（或等价）
  - Web：ConsoleShell 导航新增“执行中心”入口；新增 runs 页面与详情页

## ADDED Requirements

### Requirement: Run 列表（Execution Center）
系统 SHALL 提供 Run 列表视图，展示当前 space 下的 runs，并支持基础筛选与分页。

#### Scenario: 查看与筛选 Run
- **WHEN** 用户打开“执行中心”Run 列表页
- **THEN** UI 展示 runs（runId、status、trigger、createdAt、startedAt、finishedAt、createdBy、traceId(如有)、summary(摘要)）
- **AND** UI 支持按 status 与时间范围筛选，并支持 limit 分页
- **AND** 用户可点击进入某 run 详情页

### Requirement: Run 详情与 Step 列表
系统 SHALL 提供 Run 详情视图，展示 run 元数据与 steps 列表，并显示可解释的执行与错误摘要（仅摘要，不展示敏感原文）。

#### Scenario: 查看 Run 详情
- **WHEN** 用户打开某 run 详情页
- **THEN** UI 展示 run 元数据（status、trigger、idempotencyKey(若可见)、createdBy、policySnapshotDigest(摘要)、inputDigest(摘要)、traceId）
- **AND** UI 展示 steps 列表（stepId、status、toolRef、attempt、startedAt、finishedAt、errorCategory、outputDigest(摘要)）

### Requirement: 进行中 Run 的自动刷新（MVP：轮询）
系统 SHALL 在 Run 未 finished（running/queued/pending 等）时自动刷新状态，以提供可解释进度。

#### Scenario: 进度自动更新
- **GIVEN** run 状态为 running 或 queued
- **WHEN** 用户停留在 run 详情页
- **THEN** UI 每隔固定间隔刷新 run/steps 状态
- **AND** run 进入 finished 后停止自动刷新

### Requirement: Cancel（取消）入口
系统 SHALL 允许有权限的用户取消 queued/running 的 run，并在 UI 中提供可见入口与结果反馈。

#### Scenario: 取消成功
- **GIVEN** run.status 为 queued 或 running
- **WHEN** 用户在 run 详情页点击取消并确认
- **THEN** 系统将 run 标记为 canceled（或进入可解释的取消态）
- **AND** 系统写入审计事件（action=run.cancel 或等价）
- **AND** UI 刷新并展示最终状态

#### Scenario: 取消被拒绝
- **GIVEN** run 已 finished
- **WHEN** 用户尝试取消
- **THEN** 系统返回稳定 errorCode 与 traceId
- **AND** UI 展示错误并保持原状态不变

### Requirement: Retry（重试）入口（MVP）
系统 SHALL 允许有权限的用户对 failed 的 run 触发一次“重入队重试”（语义为继续执行失败步骤或重新执行计划内步骤，具体以实现为准），并保持同一 runId 的生命周期可追踪。

#### Scenario: 重试成功入队
- **GIVEN** run.status 为 failed
- **WHEN** 用户触发 retry
- **THEN** 系统将 run 重新入队（或进入 retrying/queued）并写入审计事件（action=run.retry 或等价）
- **AND** UI 展示状态变化并进入自动刷新

### Requirement: 授权与隔离
系统 SHALL 仅允许用户访问其 tenant/space 范围内的 runs，并对 run.read/run.cancel/run.retry 进行 RBAC 校验；系统 SHALL 不因 UI 可见性而放松后端鉴权。

#### Scenario: 跨 space 拒绝
- **WHEN** 用户访问非本 space 的 runId
- **THEN** 系统返回稳定 errorCode（例如 FORBIDDEN/NOT_FOUND 策略之一）与 traceId
- **AND** 写入审计拒绝事件（至少记录拒绝原因摘要）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）
