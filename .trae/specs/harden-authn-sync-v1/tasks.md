# Tasks
- [x] Task 1: 落地 PAT 数据模型与基础仓储
  - [x] SubTask 1.1: 新增迁移：auth_tokens（哈希、归属、过期/撤销、索引）
  - [x] SubTask 1.2: 新增 tokenRepo：create/list/revoke/findByHash
  - [x] SubTask 1.3: 确保审计字段与 DLP 摘要不包含 token 明文

- [x] Task 2: 实现 AuthN=pat 与 Token 管理 API
  - [x] SubTask 2.1: 扩展 authenticate()：支持 AUTHN_MODE=pat，校验撤销/过期并建立 subject 上下文
  - [x] SubTask 2.2: 新增 routes：POST/GET/POST revoke 的 token 管理接口
  - [x] SubTask 2.3: RBAC 对齐：为 token 管理定义 resourceType/action 并接入 requirePermission

- [x] Task 3: 加固 sync.push：复用数据面校验与 AuthZ 决策
  - [x] SubTask 3.1: 为 sync op 增加 Schema 校验与字段类型检查（最小覆盖）
  - [x] SubTask 3.2: 执行字段级写规则（applyWriteFieldRules）并对违规字段返回可解释拒绝
  - [x] SubTask 3.3: 对每个 op 执行 entity.create/entity.update 的 AuthZ 决策与 rowFilters_write 验证
  - [x] SubTask 3.4: 输出稳定的 accepted/rejected/conflicts 与 deterministic digest（不含明文 patch）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: e2e：创建 PAT→访问受保护 API→撤销→再次访问返回 401
  - [x] SubTask 4.2: e2e：sync.push 对不可写字段/无权限/行级不满足返回 rejected/conflicts
  - [x] SubTask 4.3: 回归：审计事件与 outputDigest 不包含 token/patch 明文

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2（以便使用真实鉴权上下文验证权限/行级）
- Task 4 depends on Task 2, Task 3
