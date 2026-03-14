# 隐私分区与分区密钥：Key Hierarchy / Rotation v1 Spec

## Why
《架构设计.md》提出“隐私分区与分区密钥：以空间/身份为边界做密钥隔离”，以支持最小化爆炸半径、可审计使用、轮换/撤销后失效。当前系统已具备 SecretRecord（对称加密托管）但缺少分区密钥层级与轮换机制，无法满足空间级隔离与可控轮换的工程不变式。

## What Changes
- 引入 Key Hierarchy（MVP：平台主密钥 → 租户/空间分区密钥 → 记录级数据密钥）
- 为 SecretRecord（以及未来需要加密落库的 payload）增加 key 版本与分区信息
- 提供密钥轮换流程（MVP：空间/租户密钥轮换；支持逐批重加密）
- 审计对齐：key 创建/轮换/重加密/撤销写入审计（不暴露密钥材料）
- **BREAKING（受控）**：新写入的 SecretRecord 必须带 keyRef（老数据保持可读）

## Impact
- Affected specs:
  - 连接器与密钥托管（SecretRecord 加密托管升级）
  - 安全与内容治理中枢（密钥域/撤销/轮换作为治理能力的一部分）
  - 审计域（新增 keyring 相关审计事件）
- Affected code:
  - DB：新增 keyring 表；secret_records 增加 key_ref/key_version 字段
  - API：新增 keyring 管理端点（仅管理员）
  - Shared：加密/解密工具函数（避免散落实现）

## ADDED Requirements
### Requirement: Key Hierarchy（MVP）
系统 SHALL 采用以下密钥层级：
- 平台主密钥（Master Key）：由部署方提供（环境变量/外部 KMS），仅用于加密“分区密钥材料”
- 分区密钥（Partition Key）：按租户/空间生成，用于派生或包裹记录级数据密钥
- 数据密钥（DEK）：每条记录（例如 SecretRecord）生成一次性 DEK，用于加密 payload

约束（MVP）：
- Master Key 不得写入日志/审计，不得通过 API 输出
- Partition Key 必须有版本号（keyVersion），支持轮换
- SecretRecord 的 encryptedPayload MUST 标注使用的 keyRef（scope + keyVersion）

#### Scenario: 创建空间分区密钥
- **WHEN** 管理员为某 space 初始化密钥
- **THEN** 系统生成并保存加密后的分区密钥材料（仅 Master Key 可解）
- **AND** 写审计（resourceType=keyring, action=create）

### Requirement: Envelope Encryption（MVP）
系统 SHALL 使用信封加密模式存储敏感 payload：
- 使用随机 DEK 加密明文 payload
- 使用分区密钥包裹 DEK（或使用分区密钥派生 wrapping key）

约束（MVP）：
- encryptedPayload 必须包含：ciphertext、iv/nonce、wrappedDek、keyRef
- 解密失败 MUST 返回稳定 errorCode（例如 KEY_DECRYPT_FAILED），且审计不泄露明文

### Requirement: Key Rotation（MVP）
系统 SHALL 支持分区密钥轮换：
- 轮换产生新 keyVersion，旧 keyVersion 在迁移期内仍可解密
- 提供“重加密作业”：将旧 keyVersion 的记录迁移到新 keyVersion（分批进行）

#### Scenario: 轮换后仍可用
- **GIVEN** space 已存在旧 keyVersion 的 SecretRecord
- **WHEN** 管理员轮换 spaceKey
- **THEN** 旧 SecretRecord 仍可被系统内部受控使用（解密成功）
- **AND** 新写入的 SecretRecord 使用新 keyVersion

### Requirement: Key Revocation / Disable（MVP）
系统 SHALL 支持分区密钥禁用（用于紧急响应）：
- 禁用后，使用该 keyVersion 解密的受控操作 MUST 失败（可配置是否允许只读回放）
- 审计必须记录禁用原因摘要与影响范围

### Requirement: Access Control（MVP）
系统 SHALL 限制 keyring 管理能力：
- 仅 tenant 管理员可对 tenantKey/spaceKey 执行 create/rotate/disable
- 任何 keyring API 不得返回明文密钥材料

## MODIFIED Requirements
### Requirement: SecretRecord（升级）
SecretRecord 的加密托管 SHALL 升级为：
- encryptedPayload 使用 Envelope Encryption 格式（含 keyRef）
- SecretRecord 响应继续不返回明文 payload
- 原有密文格式（legacy）在迁移期内保持可解密（MVP：双读）

## REMOVED Requirements
无

