# 安全中枢与元数据域补强 V1 Spec

## Why
当前安全中枢与元数据域主链路已可用，但仍存在策略表达、一致性执行与缓存治理缺口。需要以最小改动补齐这些缺口，将两域从“部分完成”推进到“已完成”。

## What Changes
- 安全中枢：将基于环境变量的规则配置提升为可版本化策略对象。
- 安全中枢：统一拒绝响应结构，返回 `ruleId` 摘要并保证四入口（model/tool/orchestrator/channel）一致执行。
- 安全中枢：统一审计 `safetySummary` 结构，确保不泄露 token/key 明文。
- 元数据域：补充 deprecated/移除窗口与扩展命名空间校验。
- 元数据域：为 effective schema 增加版本/快照维度缓存与失效机制。
- 元数据域：将 active/rollback 统一纳入 changeset 管道与治理门槛。
- **BREAKING**：不兼容字段变更与非法扩展命名空间将被 gate 直接拒绝。

## Impact
- Affected specs: 安全中枢（DLP/Prompt Injection 策略治理）、元数据域（Schema 兼容与 Effective Schema 解析）、治理控制面（changeset 流程）。
- Affected code:
  - `apps/api/src/server.ts`（DLP hook）
  - `apps/api/src/modules/safety/promptInjectionGuard.ts`
  - `packages/shared/src/dlp.ts`
  - `packages/shared/src/promptInjection.ts`
  - `apps/api/src/routes/schemas.ts`
  - `apps/api/src/routes/effectiveSchema.ts`
  - `apps/api/src/modules/metadata/schemaRepo.ts`
  - `apps/api/src/modules/metadata/compat.ts`

## ADDED Requirements
### Requirement: 安全策略对象版本化
系统 SHALL 将 DLP/Prompt Injection 规则以可版本化策略对象表达，并支持在请求执行时按生效版本解析，不再仅依赖散落的环境变量组合。

#### Scenario: 策略对象生效
- **WHEN** 管理面发布新的安全策略版本
- **THEN** model/tool/orchestrator/channel 四入口按同一策略版本执行

### Requirement: 安全拒绝响应统一 ruleId 摘要
系统 SHALL 在安全拒绝响应中统一返回 `ruleId` 摘要与稳定错误码，不返回敏感明文。

#### Scenario: 命中拒绝规则
- **WHEN** 请求命中 deny 规则
- **THEN** 返回包含 `ruleId` 的拒绝响应，并写入审计 `safetySummary`

### Requirement: 四入口统一策略执行
系统 SHALL 在 model/tool/orchestrator/channel 四入口执行同一安全策略决策流程与审计摘要结构。

#### Scenario: audit_only 模式
- **WHEN** 策略模式为 `audit_only`
- **THEN** 仅执行脱敏并允许请求继续，不发生拒绝

#### Scenario: deny 模式
- **WHEN** 策略模式为 `deny` 且 target 命中
- **THEN** 对应 target 被拒绝，其他未命中 target 不受影响

### Requirement: Schema deprecated 与移除窗口治理
系统 SHALL 支持字段 deprecated 标记与移除窗口校验，阻断不满足窗口约束的不兼容变更。

#### Scenario: 不兼容变更拦截
- **WHEN** 发布包含非法移除或未满足窗口的不兼容字段变更
- **THEN** 兼容性 gate 拒绝发布并返回明确原因

### Requirement: 扩展命名空间校验
系统 SHALL 校验扩展字段命名空间，仅允许受支持命名空间写入元数据。

#### Scenario: 非法命名空间
- **WHEN** Schema 扩展字段使用未注册命名空间
- **THEN** 请求被拒绝并返回稳定错误语义

### Requirement: Effective Schema 缓存与失效
系统 SHALL 为 Effective Schema 提供版本/快照维度缓存，并在版本切换或快照变化时失效。

#### Scenario: 缓存命中
- **WHEN** 同版本同快照重复请求 Effective Schema
- **THEN** 命中缓存并返回一致结果

#### Scenario: 缓存失效
- **WHEN** active 版本切换或策略快照变化
- **THEN** 对应缓存失效并返回新版本结果

### Requirement: active/rollback 纳入 changeset
系统 SHALL 将 Schema active 切换与 rollback 统一纳入 changeset 审批/发布流程。

#### Scenario: 非 changeset 直改拦截
- **WHEN** 直接调用非治理通道尝试 set-active/rollback
- **THEN** 系统拒绝并提示使用 changeset 流程

## MODIFIED Requirements
### Requirement: Safety 审计摘要最小化
系统继续记录 `safetySummary`，但必须保证只记录摘要字段（ruleId/target/decision），不记录 token/key 等敏感明文。

### Requirement: Schema 兼容与生效一致性
系统继续支持 active schema 生效，但新增要求：兼容 gate、effective cache、changeset 发布三者保持一致顺序与结果。

## REMOVED Requirements
### Requirement: 仅依赖环境变量的安全规则配置
**Reason**: 环境变量配置分散且不可版本治理，难以在四入口保持一致。
**Migration**: 保留环境变量作为默认回退来源；平台优先读取策略对象，缺失时回退到默认配置。
