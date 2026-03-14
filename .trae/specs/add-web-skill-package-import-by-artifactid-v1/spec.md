# 前端 Skill 包导入（artifactId）Spec

## Why
当前 Skill 包导入主要依赖服务端本地路径（artifactRef=绝对路径/file://），更偏同机部署与开发调试；前端侧更需要基于 artifactId 的导入方式，以便可保存、可迁移、可审计。

## What Changes
- 新增治理侧页面：上传 zip/tgz Skill 包并得到 artifactId（保存到 artifacts）。
- 在前端展示上传结果（artifactId / depsDigest / signatureStatus / scanSummary / manifestSummary），支持复制 artifactId。
- 提供“用 artifactId 发布工具版本”的前端路径（不依赖本地路径 artifactRef）。
- 后端发布接口允许“仅变更 artifact 引用”发布新版本（artifactId/artifactRef 视为有效发布内容）。
- **非目标**：引入远端 registry 服务；引入 multipart/分片上传；下载 skill 包到本机文件。

## Impact
- Affected specs: skill packages / artifact system / governance UI / tool publish flow
- Affected code:
  - Web：`apps/web/src/app/gov/*`
  - API：`apps/api/src/routes/artifacts.ts`、`apps/api/src/routes/tools.ts`

## ADDED Requirements
### Requirement: Skill 包导入（artifactId）
系统 SHALL 在治理控制台提供 Skill 包导入能力，且导入结果以 artifactId 作为稳定引用。

#### Scenario: 上传成功
- **WHEN** 用户在治理页面选择 zip/tgz Skill 包并提交
- **THEN** 前端调用 `POST /artifacts/skill-packages/upload` 上传 base64
- **AND** 页面展示 `artifactId`、`depsDigest`、`signatureStatus`、`scanSummary`、`manifestSummary`
- **AND** 用户可一键复制 `artifactId`

#### Scenario: 上传失败
- **WHEN** 上传返回非 2xx
- **THEN** 前端展示稳定错误码/消息（含 traceId）
- **AND** 不泄露包内容明文（仅展示摘要字段）

### Requirement: 基于 artifactId 发布工具版本
系统 SHALL 支持治理侧基于 artifactId 发布指定工具（toolName）的新版本，而不是依赖服务端本地路径 artifactRef。

#### Scenario: 发布成功（仅变更 artifact 引用）
- **GIVEN** toolName 已存在且具备 contract 元信息
- **WHEN** 用户输入 toolName 与 artifactId 并点击发布
- **THEN** 前端调用 `POST /tools/:name/publish` 并仅提交 `{ artifactId, depsDigest? }`（以及后端可从既有 tool definition 继承必要 contract）
- **AND** 返回 toolRef/version 信息并可用于后续 enable/execute

#### Scenario: 发布失败（manifest/信任/扫描不通过）
- **WHEN** artifact 内 manifest 与 tool contract 不一致，或信任/扫描 gate 拒绝
- **THEN** 前端展示稳定错误码与 traceId
- **AND** 不展示任何敏感明文（仅摘要与错误原因）

## MODIFIED Requirements
### Requirement: Tool publish 接口的“空发布内容”判定
`POST /tools/:name/publish` 的“发布内容为空”判定 SHALL 将 `artifactId` / `artifactRef` / `depsDigest` 视为有效发布内容之一。

## REMOVED Requirements
无

