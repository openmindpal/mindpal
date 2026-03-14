# OpenSlin 开源发布准备（Repo Hygiene + 社区规范）V1 Spec

## Why
根据 `架构设计.md` 的“统一链路、扩展只走契约、默认可治理”不变式，仓库对外开源时需要补齐可公开发布的最小配套：许可证、贡献流程、安全披露、行为准则、以及去私有化的默认配置说明，避免使用者在缺少护栏的情况下误用或引入安全风险。

## What Changes
- 新增开源发布基础文档：
  - LICENSE（默认 MIT，可按需要替换）
  - CONTRIBUTING.md（贡献流程、开发环境、提交规范、测试方式）
  - CODE_OF_CONDUCT.md（社区行为准则）
  - SECURITY.md（漏洞报告渠道与处理流程）
- README.md 开源化补全：
  - 增加“安全提示/默认安全边界”（dev token、默认凭证、DLP/Safety 模式）
  - 增加“架构文档索引”指向 `架构设计.md` 与细分架构文档
  - 增加“最小部署拓扑”说明（docker compose 仅用于本地开发）
- 仓库卫生（Repo Hygiene）：
  - 确认 `.env.example` 不包含任何真实 secret，默认值明确标注“仅本地开发”
  - 增加基础 CI（GitHub Actions）：拉起安装→单元/集成测试→构建检查（不发布制品）
  - 增加简单的 secret 扫描/敏感信息检查（基于规则的 grep，V1）

## Impact
- Affected specs:
  - 安全中枢（Safety/DLP）与默认安全边界说明
  - BFF/API 与统一请求链路（dev 模式说明）
  - 治理控制面（对外贡献的变更准入与回归要求）
- Affected code:
  - 仓库根目录文档：README.md、LICENSE、CONTRIBUTING.md、CODE_OF_CONDUCT.md、SECURITY.md
  - GitHub CI 配置：.github/workflows/ci.yml（新增）

## ADDED Requirements

### Requirement: OssLicenseV1
仓库 SHALL 包含标准许可证文件 `LICENSE`，用于明确开源许可。

#### Scenario: 许可证可被发现
- **WHEN** 用户访问仓库根目录
- **THEN** 可以看到 `LICENSE` 文件

### Requirement: OssContributingV1
仓库 SHALL 提供贡献指南 `CONTRIBUTING.md`，包含最小贡献闭环：
- 本地启动方式（与 README 一致）
- 代码规范与测试命令（不要求一键发布）
- PR/Issue 基本要求（变更说明、测试覆盖、风险评估）

#### Scenario: 新贡献者可自助跑通
- **WHEN** 新贡献者按贡献指南操作
- **THEN** 可在本地跑通 dev 与测试

### Requirement: OssSecurityPolicyV1
仓库 SHALL 提供 `SECURITY.md`，明确：
- 漏洞报告渠道（建议私密渠道/邮箱占位符）
- 处理 SLA（可用“尽快响应/按严重性分级”）
- 公开披露策略（修复后披露）

#### Scenario: 漏洞报告有入口
- **WHEN** 用户发现安全问题
- **THEN** 可在 `SECURITY.md` 中找到报告方式

### Requirement: OssCodeOfConductV1
仓库 SHALL 提供 `CODE_OF_CONDUCT.md`，明确社区行为准则与执行机制（最小版本即可）。

### Requirement: DefaultSecurityFootnoteV1
README.md SHALL 以显眼方式说明默认安全边界与仅开发模式配置：
- dev token 仅用于本地开发
- `.env.example` 中的默认值不得用于生产
- Safety/DLP 的默认模式与风险

### Requirement: OssCiBaselineV1
仓库 SHALL 提供基础 CI 工作流（V1）：
- 触发：push / pull_request
- 步骤：安装依赖 → 运行测试（至少 apps/api）→ 构建检查（可选）
- CI 不需要访问任何真实 secret（仅使用空环境或 mock）

### Requirement: BasicSecretHygieneV1
仓库 SHALL 提供最小的敏感信息防护检查（V1）：
- 检查 `.env.example` 不包含明显的 secret 模式（例如“sk-”“BEGIN PRIVATE KEY”）
- 检查仓库中不误提交 `.env`、密钥文件、token 明文（基于规则扫描）

## MODIFIED Requirements

### Requirement: ReadmeLocalDevV1
README.md 的本地启动说明 SHALL 与实际脚本保持一致，并明确 docker compose 仅用于本地开发。

## REMOVED Requirements
（无）

