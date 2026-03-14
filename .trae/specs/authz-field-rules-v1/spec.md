# AuthZ Field Rules（字段级读写裁剪与拒绝）V1 Spec

## Why
当前 RBAC 授权链路已具备 resource/action 级的 allow/deny，并能固化 Policy Snapshot，但 `fieldRules` 在实现层面仍是“默认全字段放行”，导致：
- Effective Schema 只能做“展示层标记 writable”，无法形成强约束
- 数据平面（通用 CRUD）与工具执行链路无法证明“字段级最小权限”
- 权限变化后结果不可解释（无法回答：为什么某字段对某主体不可见/不可写）

依据 `架构设计.md` 的不变式（扩展只走契约、策略先于执行、审计不可跳过、Effective Schema 是前端唯一元数据视图），需要将字段级授权从“展示建议”升级为“强制约束”，并将其纳入 Policy Snapshot 与审计摘要。

## What Changes
- 权限模型扩展（V1）
  - 为 `permissions` 增加字段级规则（JSONB），分别描述 read/write 的 allow/deny 列表
  - 规则合并策略：同一 subject 在同一 scope 下命中的多条 permission 合并为最终 fieldRules（见 Requirements）
- 授权引擎增强（V1）
  - `authorize()` 在计算 allow/deny 的同时，输出稳定的 `fieldRules`（写入 Policy Snapshot）
- Effective Schema 强制反映 fieldRules（已具备基础能力，V1 补齐来源与一致性）
  - read 裁剪：不可读字段不出现在 effective schema
  - write 标记：不可写字段 `writable=false`
- 数据平面强制执行（V1）
  - 读：实体 get/query/list 返回的 payload 必须剔除不可读字段
  - 写：create/update/patch 对不可写字段返回明确错误码（例如 `FIELD_WRITE_FORBIDDEN`）
- 审计摘要增强（V1）
  - 对拒绝/裁剪行为写入结构化摘要（字段数、被拒绝字段列表可选截断），不写入敏感明文

## Impact
- Affected specs:
  - 认证与授权（RBAC→字段级规则）
  - 元数据平面（Effective Schema 作为唯一视图）
  - 数据平面（通用 CRUD 强制裁剪与拒绝）
  - 审计域（可解释决策摘要）
- Affected code:
  - DB migrations：permissions 表新增 JSONB 字段
  - AuthZ：`authorize()` 合并规则并写 Policy Snapshot
  - Data plane：entity 读写路径增加字段裁剪/写入校验
  - Errors：新增字段级拒绝错误码

## ADDED Requirements

### Requirement: PermissionFieldRulesSchemaV1
系统 SHALL 支持在 permission 维度存储字段级规则：
- `permissions.field_rules_read`：{ allow?: string[], deny?: string[] }
- `permissions.field_rules_write`：{ allow?: string[], deny?: string[] }
- `allow=["*"]` 表示全字段允许；`deny` 永远优先生效
- 未配置（NULL）表示“不对字段做额外限制”（由合并策略决定最终结果）

#### Scenario: deny 优先
- **WHEN** allow 包含字段 `a` 且 deny 包含字段 `a`
- **THEN** 最终 MUST 视为拒绝（不可读/不可写）

### Requirement: FieldRulesMergePolicyV1
系统 SHALL 定义并实现稳定的 fieldRules 合并策略（同一 subject 在同一 scope 的多 permission 合并为最终规则）：
- 读规则合并：
  - deny：并集（union）
  - allow：若任一 permission 的 allow 包含 `"*"`，则最终 allow 为 `"*"`；否则为 allow 的并集
- 写规则合并：同读规则合并策略

#### Scenario: 多 permission 合并
- **WHEN** 角色 A 允许 read.allow=["x"]，角色 B 允许 read.allow=["y"]
- **THEN** 最终 read.allow MUST 为 ["x","y"]

### Requirement: PolicySnapshotIncludesFieldRulesV1
系统 SHALL 将最终 fieldRules 写入 Policy Snapshot，并在 `authorize()` 返回中携带：
- **WHEN** 对任意 resourceType/action 完成授权计算
- **THEN** decision.fieldRules MUST 可用于 Effective Schema 与数据平面强制执行

### Requirement: EffectiveSchemaEnforcedV1
系统 SHALL 基于 decision.fieldRules 生成 Effective Schema：
- **WHEN** 请求 `/schemas/:entity/effective`
- **THEN** 不可读字段不得出现在返回 fields 中
- **AND** 不可写字段 MUST 标记为 `writable=false`

### Requirement: EntityReadFieldRedactionV1
系统 SHALL 在实体读路径对 payload 做字段裁剪：
- **WHEN** 主体对实体执行 read
- **THEN** 返回 payload 中不得包含不可读字段

### Requirement: EntityWriteFieldRejectionV1
系统 SHALL 在实体写路径对字段进行强制校验：
- **WHEN** create/update 请求试图写入不可写字段
- **THEN** 返回明确错误码（例如 `FIELD_WRITE_FORBIDDEN`）
- **AND** 写入不得发生（保持原子性）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

