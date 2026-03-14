# ArtifactPolicy 治理配置 V1 Spec

## Why
《架构-12-安全中枢》提出 ArtifactPolicy：导出/备份等数据产物的下载令牌、有效期、次数限制与水印策略应可治理、可版本化、可灰度、可回滚并写审计。

当前已实现：
- 下载短期令牌与次数限制（V1 固定默认值由客户端决定）
- 下载审计摘要不丢失关键字段
- 下载水印/来源标识响应头（V1 全量开启）

但缺少“治理控制面”来统一约束与下发默认策略，导致：
- 客户端可任意选择 `expiresInSec/maxUses`，不符合“策略先于执行/客户端不可信”的不变式；
- 水印能力无法按“高敏/特定产物类型”策略化启停；
- 无法对策略变更做审计与回滚。

## What Changes
- 新增 ArtifactPolicy 存储与查询（space/tenant 两级）
- 新增治理 API：
  - `GET/PUT /governance/artifact-policy`（读写当前 scope 的策略）
- 调整 token 签发接口策略来源：
  - `POST /artifacts/:artifactId/download-token` 忽略客户端传入的 `expiresInSec/maxUses`，改为读取治理 ArtifactPolicy 注入
- 兼容性（V1）：
  - 若未配置 ArtifactPolicy：使用安全默认值（expiresInSec=300、maxUses=1、watermarkHeaders=true）

## Impact
- Affected specs:
  - 安全中枢（ArtifactPolicy 首次落地并可治理）
  - 治理控制面（配置、审计、回滚）
  - 数据产物外发链路（token 签发必须受控）
- Affected code:
  - DB migrations：artifact_policies 表
  - API：governance routes + artifacts routes
  - Tests：api e2e 覆盖“客户端参数不生效/默认值/治理覆盖”

## ADDED Requirements

### Requirement: ArtifactPolicyStorageV1
系统 SHALL 存储 ArtifactPolicy：
- scope：`space | tenant`（space 优先于 tenant）
- 字段（V1 最小集合）：
  - `downloadTokenExpiresInSec`（默认 300，最大 3600）
  - `downloadTokenMaxUses`（默认 1，最大 10）
  - `watermarkHeadersEnabled`（默认 true）

### Requirement: ArtifactPolicyGovernanceApiV1
系统 SHALL 提供治理 API：
- `GET /governance/artifact-policy?scopeType=space|tenant`
- `PUT /governance/artifact-policy`
  - body：`{ scopeType, downloadTokenExpiresInSec, downloadTokenMaxUses, watermarkHeadersEnabled }`
- 权限（V1）：
  - `artifact.policy.read`
  - `artifact.policy.write`
- 审计：治理写入必须写审计摘要（不含敏感信息）

### Requirement: DownloadTokenUsesGovernedArtifactPolicyV1
系统 SHALL 以治理策略决定 token 参数：
- **WHEN** 调用 `POST /artifacts/:artifactId/download-token`
- **THEN** 服务端 MUST 忽略客户端传入的 `expiresInSec/maxUses`
- **AND** MUST 使用治理下发的 ArtifactPolicy（space 优先）
- **AND** 若无配置，则使用安全默认值

### Requirement: WatermarkHeadersToggleV1
系统 SHALL 允许通过 ArtifactPolicy 控制水印响应头：
- **WHEN** `watermarkHeadersEnabled=false`
- **THEN** 下载响应 MUST 不包含 `X-Artifact-Watermark-Id/X-Artifact-Source`
- **AND** 审计仍保留 `watermarkId/artifactSource`（用于内部追溯）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

