# Media Contract：对象存储与分片上传（MVP）Spec

## Why
《架构设计.md》提出“多模态与媒体流水线：对象存储与分片上传”，以支撑大文件/多模态素材的可靠上传、下载与异步处理，并让审计/治理/溯源在统一的 Media Contract 上闭环。当前实现将媒体字节写入数据库（`media_objects.content_bytes`），不适合大文件与分片上传，也不利于后续转码/抽帧等流水线扩展。

## What Changes
- 引入媒体内容存储抽象（Blob Store），并以“可替换后端”方式落地（MVP：本地文件系统后端）
- 扩展 MediaObject：从“字节内联存库”演进为“元数据 + contentRef（storageProvider/storageKey）”
- 提供分片上传（upload session）API：创建会话、上传分片、完成合并；完成后生成 `mediaRef`
- 下载 API 支持从 Blob Store 读取内容并返回原始字节（保留现有 RBAC/审计语义）
- 兼容性：历史 `content_bytes` 数据仍可被下载（MVP 允许双读路径，迁移由后续任务完成）

## Impact
- Affected specs:
  - Media Contract：素材对象与处理流水线 MVP（内容存储后端升级）
  - Audit Contract：上传/下载审计字段保持“只记录摘要与引用”
  - Safety Contract：为后续扫描/水印/版权校验提供稳定的 contentRef 输入
- Affected code:
  - DB：`media_objects` 增加 `storage_provider/storage_key`（以及必要索引）
  - API：新增 `/media/uploads/*` 分片上传端点；调整 `/media/objects/:id/download` 读 Blob
  - Worker：`media.process` 读取 contentRef 而非 DB bytea

## ADDED Requirements
### Requirement: Blob Store 抽象（MVP）
系统 SHALL 提供可替换的媒体内容存储抽象（Blob Store）：
- `put(key, bytes, contentType) -> { byteSize, sha256 }`
- `get(key) -> { bytes, contentType }`
- `compose(keys[], targetKey) -> { byteSize, sha256 }`（用于分片合并；MVP 可用临时文件实现）

后端（MVP）：
- MUST 提供本地文件系统后端（用于开发/单机部署）
- storageKey MUST 不可由外部直接指定（防止目录穿越与越权覆盖）

### Requirement: MediaObject contentRef（MVP）
系统 SHALL 扩展 `media_objects` 支持 contentRef：
- `storageProvider`（例如 `fs` 或 `db_legacy`）
- `storageKey`（对 Blob Store 的不透明引用）

约束（MVP）：
- 对同一 `mediaId`，`content_bytes` 与 `storageKey` 至少存在其一
- 下载时优先读取 `storageKey`；若不存在则回退读取 `content_bytes`

#### Scenario: 创建对象后可下载
- **WHEN** 用户完成上传
- **THEN** MediaObject 返回 `mediaRef`
- **AND** 可通过下载接口获取原始内容

### Requirement: 分片上传会话（MVP）
系统 SHALL 支持分片上传会话：
- `POST /media/uploads` 创建会话
- `PUT /media/uploads/:uploadId/parts/:partNumber` 上传分片
- `POST /media/uploads/:uploadId/complete` 完成合并并生成 MediaObject
- `POST /media/uploads/:uploadId/abort` 终止并清理临时分片（可选，MVP 推荐支持）

会话字段（MVP）：
- `uploadId`、`tenantId`、`spaceId`
- `contentType`
- `status`（`open|completed|aborted|expired`）
- `createdAt`、`expiresAt`

分片约束（MVP）：
- partNumber MUST 从 1 开始且上限受控（例如 <= 10_000）
- 单分片大小与总大小 MUST 受配置上限控制

#### Scenario: 分片上传成功
- **WHEN** 客户端创建会话并上传若干分片后完成
- **THEN** 返回 `mediaId/mediaRef/byteSize/sha256`

### Requirement: 审计与数据最小化（MVP）
系统 SHALL 记录上传/下载审计，但不得记录原始字节：
- upload：记录 `mediaId/mediaRef/byteSize/sha256/partCount` 等摘要
- download：记录 `mediaId/byteSize/contentType` 等摘要

### Requirement: 权限与隔离（MVP）
系统 SHALL 强制 tenant/space 隔离：
- upload session 与最终 MediaObject MUST 绑定 `tenantId/spaceId`
- 任何跨 space 下载/完成会话 MUST 被拒绝

## MODIFIED Requirements
### Requirement: MediaObject 上传（更新）
原 `POST /media/objects`（base64 上传）在后续演进中 SHOULD：
- 用于小文件/调试路径
- 内部实现复用 Blob Store（而非写入 `content_bytes`）

## REMOVED Requirements
无

