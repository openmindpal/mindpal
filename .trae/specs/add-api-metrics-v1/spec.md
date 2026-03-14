# API 可观测性指标（/metrics）V1 Spec

## Why
《架构-02-BFF与统一API请求链路.md》要求平台具备可观测性（QPS、延迟、错误率、授权拒绝率、审计失败率等），以支撑治理与运维排障。当前系统主要依赖日志与审计查询，缺少低成本、可聚合、可告警的指标出口，需要在 API 层补齐最小指标链路。

## What Changes
- 新增 API 指标采集：对每次请求记录计数与延迟分布（低基数标签）
- 新增指标出口：`GET /metrics` 返回 Prometheus 文本格式（V1）
- 新增指标安全：`/metrics` 仅允许具备管理权限的主体访问（或使用 master key/管理 token，按现有鉴权体系对齐）
- 指标聚合维度约束：禁止写入 traceId/requestId/用户输入等高基数数据

## Impact
- Affected specs:
  - BFF/API 与统一请求链路（可观测性）
  - 审计域（审计失败率需可观测）
  - 认证与授权（拒绝率维度）
- Affected code:
  - API：请求管线/插件（onRequest/onResponse/onError）
  - API：新增 /metrics 路由与权限校验

## ADDED Requirements

### Requirement: 指标采集（V1）
系统 SHALL 在 API 层对每次请求采集最小指标集合：
- 请求计数：按 method + routePattern + statusClass（2xx/4xx/5xx）聚合
- 请求延迟：按 method + routePattern 聚合（至少 P50/P95 可计算，或用桶近似）
- 授权拒绝计数：按 resourceType + action 聚合
- 审计写入失败计数：按 errorCode（固定集合）聚合

#### Scenario: 成功请求计数与延迟
- **WHEN** 任意 API 请求完成（成功或失败）
- **THEN** 对应计数器增加
- **AND** 对应延迟分布更新（不包含请求体内容）

### Requirement: 指标出口（/metrics）
系统 SHALL 提供 `GET /metrics`：
- 返回 Prometheus 文本格式（Content-Type = `text/plain; version=0.0.4` 或等价）
- 指标名称与标签集合稳定（V1 内不破坏兼容）
- 指标中不得包含敏感数据或高基数字段

#### Scenario: 拉取指标
- **WHEN** 管理者访问 `GET /metrics`
- **THEN** 返回 200 且包含至少一条请求计数指标与延迟指标

### Requirement: 指标访问控制
系统 SHALL 对 `GET /metrics` 做访问控制：
- 默认拒绝未鉴权或无权限主体
- 允许的鉴权方式与现有 Admin/治理接口一致（复用已有 guard）

#### Scenario: 未授权访问被拒绝
- **WHEN** 未鉴权主体访问 `/metrics`
- **THEN** 返回 401/403（与现有错误规范一致），并写审计（read/deny 摘要）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

