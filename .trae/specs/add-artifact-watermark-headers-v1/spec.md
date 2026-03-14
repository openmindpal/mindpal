# Artifact Watermark Headers（产物水印/来源标识-响应头）V1 Spec

## Why
这里的“水印/来源标识”不是给文件内容打花字水印，而是给**每次下载**分配一个可追溯的标识（watermarkId），并输出“这个产物来自哪次运行/哪一步”的来源摘要（artifactSource）。

重要性：
- **离线流转可追溯**：产物被转发/上传到外部后，只要保留响应头或能在下载链路中留存该标识，就能在审计中快速定位“谁在什么时候下载了哪个产物”（责任定位/排障/合规）。
- **为后续高敏策略铺路**：《架构-12》提到“对高敏数据可选水印/来源标识”，V1 先做最小不破坏兼容性的实现（只加响应头与审计摘要），后续再演进到 ArtifactPolicy 驱动、甚至内容内嵌水印。

V1 设计选择：不改变 artifact body（避免破坏 json/jsonl 消费方），也不输出任何 token 明文或用户隐私字段。

## What Changes
- 下载响应新增水印/来源标识响应头（V1）：
  - `X-Artifact-Watermark-Id`：用于追溯下载会话
  - `X-Artifact-Source`：用于表达产物来源（建议 JSON 字符串）
- 下载审计摘要增强（V1）：
  - `outputDigest.watermarkId`
  - `outputDigest.artifactSource`
- 覆盖范围（V1）：
  - 必做：`GET /artifacts/download?token=...`（治理审计页与短期令牌下载链路已使用）
  - 可选：`GET /artifacts/:artifactId/download`（Bearer 直链下载；若担心暴露更多元信息，可在 V1 暂不改）

## Impact
- Affected specs:
  - 安全中枢（ArtifactPolicy 的水印/来源标识基础能力）
  - 审计域（下载事件可追溯、可对账）
- Affected code:
  - API：`apps/api/src/routes/artifacts.ts`
  - Tests：`apps/api/src/__tests__/e2e.test.ts`

## ADDED Requirements

### Requirement: ArtifactDownloadWatermarkHeadersV1
系统 SHALL 在 artifact 下载响应中输出水印/来源标识响应头：
- **WHEN** 请求 `GET /artifacts/download?token=...` 成功返回 200
- **THEN** 响应 MUST 包含：
  - `X-Artifact-Watermark-Id`：string
  - `X-Artifact-Source`：string
- **AND** `X-Artifact-Watermark-Id` MUST 与审计摘要中的 `watermarkId` 一致

水印 ID 生成（V1 最小规则）：
- token 下载：`watermarkId = tokenId`（不含 token 明文；tokenId 非机密）
（可选）bearer 下载：`watermarkId = "artifact:" + artifactId`（或等价稳定形式）

来源标识（V1 最小集合，建议 JSON 字符串）：
- `artifactId`
- `type`
- `format`
- `runId?`
- `stepId?`

安全约束（V1）：
- `X-Artifact-Source` MUST NOT 包含下载者 subjectId/token 明文/连接器密钥等敏感信息
- `X-Artifact-Watermark-Id` MUST NOT 复用 token 明文

### Requirement: ArtifactDownloadAuditWatermarkV1
系统 SHALL 在下载审计事件中记录水印/来源摘要：
- **WHEN** 下载成功（200）
- **THEN** audit `outputDigest` MUST 包含：
  - `watermarkId`
  - `artifactSource`（最小集合）

### Requirement: NonBreakingContentV1
- **WHEN** 启用 V1 水印/来源标识
- **THEN** 系统 MUST 不改变 artifact body（不进行内容内嵌水印）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）
