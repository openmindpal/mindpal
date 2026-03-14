# Tasks
- [x] Task 1: 新增 Keyring 数据模型与迁移
  - [x] SubTask 1.1: DB migrations：tenant_keys / space_keys / key_versions（或等价）
  - [x] SubTask 1.2: secret_records 增加 keyRef/keyVersion/format 字段并兼容 legacy

- [x] Task 2: 实现加密库（Envelope Encryption）
  - [x] SubTask 2.1: shared 加密工具：encrypt/decrypt + keyRef 解析
  - [x] SubTask 2.2: 失败模式与错误码（KEY_DECRYPT_FAILED/KEY_DISABLED 等）

- [x] Task 3: 接入 SecretRecord 写入与受控使用
  - [x] SubTask 3.1: 创建 secret 时按 scope 获取分区密钥并加密
  - [x] SubTask 3.2: 内部读取时双读（legacy/new）并统一返回结构
  - [x] SubTask 3.3: 审计对齐（不输出密钥材料/明文）

- [x] Task 4: 轮换与重加密（MVP）
  - [x] SubTask 4.1: API：rotate tenant/space key（仅管理员）
  - [x] SubTask 4.2: 作业：按批重加密旧 keyVersion 的记录（可重试）
  - [x] SubTask 4.3: API：disable keyVersion（紧急响应）

- [x] Task 5: 回归测试
  - [x] SubTask 5.1: e2e：创建 secret→不可明文读取→内部可用
  - [x] SubTask 5.2: e2e：轮换后新写入用新版本，旧记录仍可用
  - [x] SubTask 5.3: e2e：禁用版本后受控使用失败且可审计

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 3, Task 4
