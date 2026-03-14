# 技能包 Artifact Registry + 模型接入向导 + 凭证轮转 V1 Spec

## Why
当前 Tool/Skill 发布支持 `artifactRef` 指向本地目录，这在团队/生产环境不可移植且难以审计与版本化管理；同时模型接入需要串联 connector/secret/binding，多数用户缺少一站式引导与高可用凭证轮转能力。

## What Changes
- 引入内部“Skill Artifact Registry”：支持上传 zip/tgz 技能包，服务端解包、计算 `depsDigest`、校验 `manifest.signature`，持久化并生成 `artifactId`
- 扩展 Tool 发布：`POST /tools/:name/publish` 支持用 `artifactId` 发布版本（或生成受控 `artifactRef`），避免依赖本地路径
- Worker 加载增强：支持从 registry 引用加载 skill 包（支持本地缓存与一致性校验），并保持现有出站治理/沙箱/信任策略语义一致
- 新增前端“模型/连接器向导页”：新增 `/gov/models`（或 `/admin/integrations`）三步引导（connector instance → secret → model binding）
- 模型高可用：在同一 `provider/modelRef` 下支持绑定多把 key（多个 secret），仅在 429/timeout 等可重试错误时轮转切换

## Impact
- Affected specs:
  - Skill 包格式与可插拔执行（artifactRef/depsDigest/签名信任）
  - 连接器与密钥托管（Connector/Secrets）
  - Model Gateway（路由/熔断/用量归集）
  - Governance（工具与模型的安全治理入口）
- Affected code:
  - API：artifacts、tools publish、models bindings
  - Worker：skill 包加载与 artifact 引用解析
  - Web：新增模型向导页面；可选增强 tools 发布 UI
  - DB：新增/扩展技能包 registry 与模型绑定多密钥结构

## ADDED Requirements

### Requirement: SkillArtifactRegistryV1（内部技能仓库）
系统 SHALL 提供技能包（zip/tgz）的受控上传与版本化存储能力，并返回稳定的 `artifactId` 用于发布工具版本。

#### Scenario: 上传技能包成功
- **WHEN** 管理者上传 zip/tgz 包（包含 `manifest.json` 与 entry 指定的构建产物）
- **THEN** 服务端解包、解析 manifest
- **AND** 计算 `depsDigest`（稳定 sha256 摘要）
- **AND** 校验 `manifest.signature`（在启用信任策略时必须通过）
- **AND** 将包内容写入 registry 并返回 `artifactId`、`depsDigest`、`manifest` 摘要（不得返回敏感内容）

#### Scenario: 上传技能包失败
- **WHEN** 包缺少必需文件、manifest 不一致、签名不可信、或解包失败
- **THEN** 返回 400/403（稳定 errorCode）
- **AND** 写审计（errorCategory=policy_violation，且不记录包内容与签名明文）

### Requirement: PublishToolFromArtifactV1（用 artifactId 发布工具版本）
系统 SHALL 支持通过 `artifactId` 发布 Tool Version，避免直接依赖本地 `artifactRef` 路径。

#### Scenario: 用 artifactId 发布
- **WHEN** 调用 `POST /tools/:name/publish` 且提供 `artifactId`
- **THEN** 服务端从 registry 取回 manifest/entry 并再次执行一致性校验
- **AND** tool version 记录 `depsDigest` 与 artifact 引用（`artifactId` 或等价受控 `artifactRef`）
- **AND** 返回 `toolRef`

#### Scenario: 兼容现有 artifactRef
- **WHEN** 调用 publish 仍提供旧的 `artifactRef`
- **THEN** 系统保持现有行为不变（V1 兼容）

### Requirement: WorkerLoadFromRegistryV1（Worker 从 registry 引用加载）
worker SHALL 支持加载 registry 引用的技能包，并在执行前后保持现有安全语义一致：
- 仍执行 `depsDigest` 一致性校验
- 仍执行签名/信任策略（生产默认拒绝未受信包）
- 仍执行出站域名治理与执行沙箱策略

#### Scenario: registry 引用加载成功
- **WHEN** tool version 指向 registry artifact（通过 `artifactId` 或受控 `artifactRef`）
- **THEN** worker 以只读方式拉取/缓存到本地目录并执行 entry
- **AND** outputDigest 记录 `artifactId`（或等价引用）、`depsDigest`、`egressSummary`、`latencyMs`

#### Scenario: registry 内容不一致
- **WHEN** 拉取到的包计算出的 `depsDigest` 与 registry/tool version 不一致
- **THEN** worker MUST 拒绝执行并记录审计（policy_violation）

### Requirement: ModelOnboardingWizardUIV1（模型接入向导）
系统 SHALL 提供前端向导页，帮助用户完成模型接入的最小闭环。

#### Scenario: 向导三步完成绑定
- **WHEN** 用户进入 `/gov/models`（或 `/admin/integrations`）并选择“添加模型”
- **THEN** Step1 创建 connector instance（选择 typeName、配置 allowedDomains）
- **AND** Step2 创建 secret（API key 或 OAuth token 的加密托管；不展示明文）
- **AND** Step3 创建 model binding（选择 modelRef → connector instance + secret）
- **AND** 完成后在列表中可见当前 bindings 与可用状态（enabled/disabled 由 connector 与 secret 状态决定）

### Requirement: ModelBindingCredentialRotationV1（同一模型多密钥轮转）
系统 SHALL 支持同一 `modelRef` 绑定多个 secret，并在可重试错误时轮转切换。

#### Scenario: 仅在可重试错误时轮转
- **WHEN** 上游返回 429/速率限制，或请求超时
- **THEN** 系统尝试使用同一 binding 的下一个可用 secret 重试（按轮转策略）
- **AND** 记录到 outputDigest.attempts（不得包含 secret 明文）

#### Scenario: 不可重试错误不轮转
- **WHEN** 错误类别为 policy_violation 或参数/格式错误
- **THEN** 系统不得轮转到下一把密钥重试

## MODIFIED Requirements

### Requirement: ToolVersionArtifactRef（扩展）
Tool Version 对可执行包的引用 SHALL 支持 registry 引用（例如通过 `artifactId` 或受控 scheme），并继续兼容本地 `artifactRef`。

### Requirement: ModelBinding（扩展）
ModelBinding SHALL 支持多个 secret 关联（V1 可通过新增关联表或扩展字段实现），且保持现有单 secret 写法兼容。

## REMOVED Requirements
（无）

