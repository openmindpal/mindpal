# Media Contract：素材对象与处理流水线 MVP Spec

## Why
《架构设计.md》将 Media Contract 定义为稳定契约之一：多模态素材的对象存储、处理流水线、溯源/版权/水印元数据与内容治理接口。当前系统尚无统一的“素材对象”模型与引用方式，导致附件/证据/媒体处理只能各域自建，难以治理与审计一致化。

## What Changes
- 引入 MediaObject（素材对象）元数据模型与统一引用 `mediaRef`
- 提供最小上传/下载 API（MVP 先支持 JSON 上传，面向本地开发与小文件）
- 引入异步处理流水线入口（Job + 状态机），为转码/抽帧/字幕等后续扩展提供稳定挂点
- 与 Audit/Safety 预留对齐字段：创建/下载/处理请求均写审计；对象保存溯源与治理摘要字段

## Impact
- Affected specs: Channel/Notification Contract（附件）、Knowledge Contract（证据引用）、Audit Contract（媒体访问审计）、Safety Contract（治理结果挂点）
- Affected code:
  - DB：新增 `media_objects / media_derivatives / media_jobs`
  - API：新增 `mediaRoutes` 与 `modules/media/*`
  - Worker：新增 `media.process` 作业处理器（MVP 可仅做占位状态流转）

## ADDED Requirements
### Requirement: MediaObject 与统一引用（MVP）
系统 SHALL 提供 MediaObject 作为跨域统一素材对象，最小字段集合如下：
- `mediaId`（UUID）
- `tenantId`、`spaceId`
- `contentType`、`byteSize`、`sha256`
- `status`（`uploaded|processing|ready|failed`）
- `source`（JSONB，可选：connectorRef/messageId/url 等）
- `provenance`（JSONB，可选：版权/水印/溯源摘要）
- `safetyDigest`（JSONB，可选：内容安全/风险标签摘要）
- `createdBySubjectId`、`createdAt`、`updatedAt`

引用（MVP）：
- 系统 SHALL 使用 `mediaRef = "media:" + mediaId` 作为跨域引用值

#### Scenario: 创建 MediaObject 返回 mediaRef
- **WHEN** 调用方创建素材对象
- **THEN** 返回 `mediaId` 与 `mediaRef`

### Requirement: 上传 API（MVP）
系统 SHALL 提供上传接口以创建并写入素材内容（MVP 形态为 JSON 上传）：
- `POST /media/objects`

请求（MVP）：
- `spaceId?`（可选；缺省取 subject.spaceId）
- `contentType`（必填）
- `contentBase64`（必填；MVP 仅支持小文件，大小上限由配置控制）
- `source?`（可选）
- `provenance?`（可选）

响应（MVP）：
- `mediaId`、`mediaRef`、`byteSize`、`sha256`、`status`

审计（MVP）：
- 上传请求 MUST 写审计事件（resourceType=media，action=upload）

#### Scenario: 上传成功
- **WHEN** 用户从治理台或工具链提交上传请求
- **THEN** 创建 media_objects 记录并返回 `mediaRef`

### Requirement: 下载 API（MVP）
系统 SHALL 提供下载接口以获取素材内容：
- `GET /media/objects/:mediaId/download`

行为（MVP）：
- 返回原始字节内容（从存储解码），并设置 `content-type` 为对象 `contentType`
- 下载请求 MUST 写审计（resourceType=media，action=download）

#### Scenario: 下载成功
- **WHEN** 调用方下载已上传的 MediaObject
- **THEN** 得到与上传一致的内容与 contentType

### Requirement: 处理流水线入口（MVP）
系统 SHALL 支持对 MediaObject 发起异步处理请求，形成可扩展的处理流水线：
- `POST /media/objects/:mediaId/process`

请求（MVP）：
- `ops`（数组：`thumbnail|transcript|extractText|transcode` 的子集；MVP 可仅落库与状态流转）

行为（MVP）：
- 创建 `media_jobs` 记录（status：pending→running→succeeded/failed）
- 将作业投递到 Worker 队列（kind=media.process）
- 处理结果以 `media_derivatives` 形式记录（MVP 可仅写占位 metadata）
- 处理请求 MUST 写审计（resourceType=media，action=process.requested）

#### Scenario: 创建处理作业
- **WHEN** 调用方对某个 MediaObject 发起处理请求
- **THEN** 返回 jobId 与初始状态

### Requirement: 权限与隔离（MVP）
系统 SHALL 对 MediaObject 的读写进行 RBAC 控制（resourceType=media）：
- `media.upload`、`media.download`、`media.process`、`media.read`

隔离（MVP）：
- tenant 隔离 MUST 强制执行
- 当 subject 具备 spaceId 时，访问其他 space 的 media MUST 被拒绝

## MODIFIED Requirements
无

## REMOVED Requirements
无

