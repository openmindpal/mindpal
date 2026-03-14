# 扩展 CI 回归覆盖面 Spec

## Why
当前 CI 只执行 secret-scan 与 `apps/api test`（见 `.github/workflows/ci.yml`），Web/Worker/Device-agent/Shared 的回归未纳入流水线，容易出现“模块间集成回归漏检”（例如：shared 类型变更导致 worker/api 编译通过但 web 构建失败等）。

## What Changes
- 扩展 GitHub Actions CI 工作流的校验范围：
  - 继续保留 secret-scan
  - 增加 `apps/worker` 与 `apps/device-agent` 的测试
  - 增加 `apps/web` 的 build（可选：lint）以覆盖 Next 编译/依赖变更回归
  - 增加 `packages/shared` 的 build（即使 test 为 no-op，也能覆盖 TS 编译与产物一致性）
- 将“全仓编译/构建”作为回归底线（优先跑 `npm -ws run build --if-present`），以捕捉跨 workspace 的类型/接口回归。
- 可选新增独立的 `web e2e` Job（**非默认**）：
  - 仅在 `workflow_dispatch` 或 `schedule` 时运行，或通过环境变量开关启用
  - 该 job 负责拉起 API/Web 服务并运行 `apps/web` 的 `test`（受 `WEB_E2E=1` 控制），避免 PR 流水线引入不稳定因素

## Impact
- Affected specs: 工程效能/质量门槛、模块间回归策略
- Affected code:
  - `.github/workflows/ci.yml`（新增 jobs、构建与测试步骤、可能的 matrix）
  - 可能新增/调整 CI 环境变量与 job 触发条件（web e2e 开关）

## ADDED Requirements

### Requirement: CI 必须覆盖主要 workspace 的回归底线
系统 SHALL 在每次 push/PR 的 CI 中至少覆盖以下回归：
- `node scripts/secret-scan.mjs`
- `npm -ws run build --if-present`（全仓编译/构建）
- `npm -w apps/api test`
- `npm -w apps/worker test`
- `npm -w apps/device-agent test`
- `npm -w apps/web build`（或等价的可复现构建步骤）
- `npm -w packages/shared build`

#### Scenario: PR 改动影响 worker 编译
- **WHEN** PR 修改 `packages/shared` 的类型定义导致 `apps/worker` 编译失败
- **THEN** CI MUST fail 在 `worker build/test` 相关步骤

### Requirement: Web E2E 作为非默认增强校验
系统 SHALL 支持一个“可选”的 Web E2E job：
- 默认不在每个 PR 执行
- 仅在显式触发（workflow_dispatch/schedule）或显式开关启用时执行

#### Scenario: 手动触发 Web E2E
- **WHEN** 手动触发 workflow 并启用 Web E2E
- **THEN** CI MUST 拉起 API/Web 并执行 `apps/web test`（`WEB_E2E=1`）

## MODIFIED Requirements

### Requirement: CI 工作流的最小校验集合
现有 CI 的最小校验集合从“secret-scan + api test”修改为“secret-scan + 全仓 build + 主要 workspace tests + web build”，以降低跨模块回归漏检概率。

## REMOVED Requirements
（无）

