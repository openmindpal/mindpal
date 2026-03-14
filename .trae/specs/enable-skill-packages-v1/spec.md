# Skill 包格式与可插拔执行（Worker 动态加载）V1 Spec

## Why
《架构设计.md》提出 Tool/Skill 需要“可插拔能力单元”，并要求统一包格式、依赖摘要、版本分发与回滚。当前平台虽然已有 Tool Registry + Workflow/Queue + Skill Runtime 护栏，但工具“可执行实现”仍主要由 worker 内硬编码分发，无法通过发布/治理实现真正的生态扩展。

## What Changes
- 定义 Skill 包格式（V1）：标准目录结构 + manifest（能力声明/契约/依赖/入口）
- 扩展 Tool Version（V1）：记录 `artifactRef` 与 `depsDigest`（可回放/可追溯）
- Worker 可插拔执行（V1）：优先按 artifactRef 动态加载 Skill 实现；未配置则回退到内置实现
- 安全最小化（V1）：仅允许加载白名单目录下的本地包；对 manifest 与 depsDigest 做一致性校验
- 可观测/审计对齐（V1）：审计与 step.outputDigest 记录 `depsDigest` 与 `artifactRef`（不记录代码/敏感内容）

## Impact
- Affected specs:
  - Tool/Skill Contract（scope/resource/action/approval）
  - Skill Runtime（timeout/并发/出站治理）
  - Governance（启用/active/override + 回滚）
  - Audit（执行可追溯摘要）
- Affected code:
  - DB：tool_versions 扩展字段（artifact_ref、deps_digest 的落地与查询）
  - API：publish 时写入 artifactRef/depsDigest；版本查询返回
  - Worker：增加 Skill 包加载器与执行适配层

## ADDED Requirements

### Requirement: Skill 包格式（V1）
系统 SHALL 定义 Skill 包的最小格式：
- `manifest.json`：
  - identity：name、version
  - contract：scope、resourceType、action、idempotencyRequired、riskLevel、approvalRequired
  - io：inputSchema、outputSchema（与 Tool Registry 一致）
  - runtime：limits 默认值（可选）
  - entry：入口文件相对路径（如 `dist/index.js`）
- 产物：入口文件与必要依赖（V1 仅支持本地文件系统目录）

#### Scenario: manifest 缺字段
- **WHEN** 发布/加载的包缺少 identity/contract/entry
- **THEN** 系统拒绝注册或拒绝加载（errorCategory=policy_violation）

### Requirement: Tool Version 绑定包（artifactRef + depsDigest）
系统 SHALL 允许 Tool Version 绑定 Skill 包：
- `artifactRef`：指向 worker 可访问的本地包目录（V1 仅支持 `file://` 或等价路径引用）
- `depsDigest`：对 manifest 与入口文件（及其依赖清单）的稳定摘要（sha256）

#### Scenario: depsDigest 不匹配
- **WHEN** worker 加载包时计算摘要与 registry 记录不一致
- **THEN** worker MUST 拒绝执行该 toolRef，并写审计（policy_violation）

### Requirement: Worker 动态加载与回退（V1）
worker SHALL 在执行 toolRef step 时：
- 若 toolVersion.artifactRef 存在：加载包入口并执行
- 否则：使用内置实现（保持现有行为）

#### Scenario: 动态包执行成功
- **WHEN** toolRef 配置 artifactRef 且包加载成功
- **THEN** step 输出通过 outputSchema 校验与裁剪
- **AND** outputDigest 记录 depsDigest、artifactRef、latencyMs、egressSummary

#### Scenario: 动态包不存在
- **WHEN** artifactRef 指向不存在路径
- **THEN** step 标记 failed（policy_violation），且不进行任何副作用

### Requirement: 安全加载边界（V1）
系统 SHALL 对可加载包的来源进行约束：
- 仅允许从配置的允许目录（allowlist roots）加载本地包
- 禁止从网络 URL 动态拉取/执行

#### Scenario: 非白名单路径
- **WHEN** artifactRef 不在 allowlist roots 下
- **THEN** worker 拒绝执行（policy_violation）并写审计

## MODIFIED Requirements

### Requirement: Tool Registry 发布（扩展）
`POST /tools/:name/publish` 在保持现有字段的基础上 SHALL 支持可选的包绑定字段：
- artifactRef
- depsDigest（若未传，则由服务端根据 manifest 计算或置空，按实现策略）

## REMOVED Requirements
（无）

