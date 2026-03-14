# Tasks
- [x] Task 1: 实现 AuthN=hmac 的 token 校验与上下文绑定
  - [x] SubTask 1.1: 定义 token 格式与校验函数（HMAC-SHA256 + exp）
  - [x] SubTask 1.2: 修改 authenticate()：支持 dev/hmac 模式切换并忽略 header 注入
  - [x] SubTask 1.3: 校验失败返回 401（与现有错误码保持一致）

- [x] Task 2: Subject 自动落库与一致性校验
  - [x] SubTask 2.1: 认证成功时 upsert subjects（subjectId + tenantId）
  - [x] SubTask 2.2: tenant 不一致时拒绝（避免跨租户冒用）

- [x] Task 3: 测试与文档
  - [x] SubTask 3.1: 单测覆盖 token 校验（签名/过期/篡改）
  - [x] SubTask 3.2: e2e：hmac 模式下非法 token 拒绝；合法 token 放行
  - [x] SubTask 3.3: README：补齐 AUTHN_MODE 与 token 格式说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
