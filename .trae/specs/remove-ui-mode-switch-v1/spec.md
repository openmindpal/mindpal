# 移除 UI 模式开关（统一标准模式）V1 Spec

## Why
《架构设计.md》已明确不再采用“简易模式/治理模式”的模式切换。模式开关会引入额外状态与分支路径（配置持久化、导航分层、测试分叉），增加系统复杂性与维护成本。系统应提供一套统一标准能力，界面呈现与可用操作由 RBAC/Policy 决定。

## What Changes
- 移除“uiMode（simple/governance）”概念与相关配置链路：
  - **BREAKING**：移除 `GET /settings/ui-mode` 与 `PUT /settings/ui-mode`
  - **BREAKING**：移除 spaces 表中的 `ui_mode` 字段与约束（新增迁移）
  - 移除 API 侧 uiMode repo 与相关审计 action 命名
- Web 交互改为统一标准：
  - 移除设置页的“交互模式”切换 UI
  - ConsoleShell 导航不再按模式折叠；页面可见性由 RBAC/后端访问控制决定
  - Web 端不再在页面渲染时请求 `/settings/ui-mode`
- 更新测试与文档：
  - API e2e 移除/改写 uiMode 相关用例
  - Web e2e-console-mode 不再切换模式，改为验证统一导航与关键页面可加载
  - README 移除/更新 uiMode 相关接口说明

## Impact
- Affected specs:
  - Console 模式开关与导航（add-console-mode-switch-v1）语义废弃
  - 交互平面（UI）与页面配置（导航与权限）
  - 认证与授权（RBAC/Policy 决定可见与可用）
  - 审计域（去除 uiMode 读写审计）
- Affected code:
  - API：settings 路由、settings 模块、迁移脚本、e2e
  - Web：settings 页面、ConsoleShell、各 page 的 uiMode 初始化逻辑、e2e
  - 文档：README

## ADDED Requirements
### Requirement: 统一标准交互（V1）
系统 SHALL 仅提供一套标准的 Console 交互与治理能力，不提供“简易/治理”模式切换。

#### Scenario: 导航不依赖模式
- **WHEN** 用户访问 Web 任意页面
- **THEN** 不进行 uiMode 读取与判断
- **AND** 导航折叠/显示不依赖“模式”，仅依赖权限（或后端返回结果）

## MODIFIED Requirements
### Requirement: 设置页（V1）
设置页 SHALL 不再提供“交互模式”切换功能。

### Requirement: 访问控制（V1）
治理/管理相关页面 SHALL 继续由后端 RBAC 强制保护；前端不提供旁路权限。

## REMOVED Requirements
### Requirement: UI 模式读取/切换
**Reason**: 统一标准模式，避免引入额外配置状态与分支复杂度。
**Migration**:
- 通过数据库迁移移除 spaces.ui_mode 字段与约束；
- 删除 `/settings/ui-mode` API 与前端切换入口；
- 测试与 README 同步更新。
