# Artifact Download Token（产物下载短期令牌）V1 Spec

## Why
《架构设计.md》与《架构-12-安全中枢》要求：导出/备份等数据产物下载必须走短期令牌与访问控制（次数/有效期/可选一次性），并把下载行为写入审计，以降低“持久直链 + 长期凭证”带来的外泄风险与不可追溯问题。

当前实现仅提供 `GET /artifacts/:artifactId/download`（基于 Bearer + RBAC），缺少短期令牌与次数限制能力，不符合上述不变式。

## What Changes
- 新增 DB 表 `artifact_download_tokens`（token 只落库 hash；支持 expiresAt/maxUses/revokedAt/usedCount）
- 新增 API（V1）：
  - `POST /artifacts/:artifactId/download-token`：签发短期下载令牌
  - `GET /artifacts/download?token=...`：用 token 下载产物（无需 Bearer）
- 审计（V1）：
  - `artifact:download_token`（签发）
  - `artifact:download`（token 下载）
  - 审计摘要必须不包含 token 明文；至少包含 `artifactId/tokenId/usesAfter/expiresAt`
- Web（V1）：
  - 治理审计页面下载入口改为“先签发 token 再下载”（避免前端直拼 Bearer 下载直链）

## Impact
- Affected specs:
  - 安全中枢（ArtifactPolicy 的最小落地：短期令牌/次数限制/审计）
  - 审计域（下载可追溯）
  - 数据平面（导出/备份产物下载链路）
- Affected code:
  - API：artifacts routes + artifacts repo（token repo）
  - DB migrations：新增 token 表
  - Web：gov audit UI 下载动作
  - Tests：api e2e 覆盖 token 签发/下载/过期/用尽

## ADDED Requirements

### Requirement: ArtifactDownloadTokenStorageV1
系统 SHALL 存储下载令牌：
- 表：`artifact_download_tokens`
- 字段（V1 最小集合）：
  - `token_id`（uuid）
  - `tenant_id`
  - `space_id`
  - `artifact_id`
  - `issued_by_subject_id`
  - `token_hash`（sha256，token 明文不得入库）
  - `expires_at`
  - `max_uses`（int，默认 1）
  - `used_count`（int，默认 0）
  - `revoked_at`（nullable）
  - `created_at/updated_at`

### Requirement: IssueArtifactDownloadTokenV1
系统 SHALL 提供签发接口：
- `POST /artifacts/:artifactId/download-token`
- 权限：resourceType=`artifact` action=`download`（V1 复用现有权限）
- 请求体（V1）：
  - `expiresInSec?: number`（默认 300，最大 3600）
  - `maxUses?: number`（默认 1，最大 10）
- 响应体（V1）：
  - `token: string`（仅返回一次）
  - `tokenId: string`
  - `expiresAt: string`
  - `downloadUrl: string`（包含 token 参数）

#### Scenario: 不可签发
- **WHEN** artifact 不存在/已过期/跨 space 越权
- **THEN** 返回 400/403（稳定 errorCode）并写拒绝审计

### Requirement: DownloadArtifactByTokenV1
系统 SHALL 提供 token 下载接口：
- `GET /artifacts/download?token=...`
- token 校验（V1）：
  - 必须存在且未过期、未撤销
  - `used_count < max_uses`
  - 通过 token 关联到 artifact 后必须再次校验 artifact 未过期
- 成功响应：
  - 设置 `content-type` 为 artifact 的 `contentType`
  - 返回 `contentText`
- 使用计数：
  - 每次成功下载 MUST 原子递增 `used_count`

#### Scenario: token 无效
- **WHEN** token 不存在/过期/撤销/用尽
- **THEN** 返回 403（稳定 errorCode=`ARTIFACT_TOKEN_DENIED`）并写审计（不含 token 明文）

### Requirement: AuditForArtifactTokenV1
系统 SHALL 写入审计事件：
- 签发：`resourceType=artifact action=download_token`
- 下载：`resourceType=artifact action=download`
- 审计字段要求：
  - MUST 不包含 token 明文
  - SHOULD 包含 `artifactId/tokenId/expiresAt/maxUses/usedCountAfter`

### Requirement: WebGovAuditDownloadUsesTokenV1
治理审计页面 SHALL 通过签发 token 下载产物：
- **WHEN** 用户点击“Download artifact”
- **THEN** 前端调用 `POST /artifacts/:artifactId/download-token`
- **AND** 使用返回的 `downloadUrl` 触发下载（新窗口或 location 跳转均可）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

