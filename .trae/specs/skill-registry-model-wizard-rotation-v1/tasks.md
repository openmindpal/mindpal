# Tasks
- [x] Task 1: 设计并落地技能包 Artifact Registry（上传/存储/校验）
  - [x] 定义 registry 元数据与存储布局（artifactId、contentType、size、depsDigest、manifest 摘要、signatureStatus）
  - [x] 新增上传 API（zip/tgz）与审计事件（不记录包内容与签名明文）
  - [x] 新增查询/列举 API（按 tenant/scope）用于后续 publish 与 UI 选择

- [x] Task 2: 扩展工具发布支持 artifactId
  - [x] 扩展 `POST /tools/:name/publish` 接收 artifactId（保持 artifactRef 兼容）
  - [x] publish 时做 manifest 一致性校验与 depsDigest 计算/复核
  - [x] tool version 持久化 artifact 引用并在查询接口返回

- [x] Task 3: Worker 支持从 registry 引用加载技能包
  - [x] 实现 artifactId→本地缓存目录的解析与拉取（含校验与缓存失效策略）
  - [x] 保持现有信任策略、出站治理、沙箱执行语义不变
  - [x] outputDigest 增加 registry 引用字段（不含敏感内容）

- [x] Task 4: 新增前端模型接入向导页
  - [x] 新增 `/gov/models`（或 `/admin/integrations`）入口与导航
  - [x] Step1：选择 connector type + 创建 instance + allowedDomains 校验
  - [x] Step2：创建 secret（不回显明文）
  - [x] Step3：选择 modelRef 并创建 binding，完成后显示绑定列表与状态

- [x] Task 5: 模型绑定支持多密钥与轮转策略
  - [x] 扩展数据结构：一个 binding 关联多个 secret（兼容旧字段）
  - [x] Model Gateway 仅在 429/timeout 等可重试错误时轮转重试
  - [x] attempts 摘要记录轮转行为（不暴露 secret）

- [x] Task 6: 测试与回归
  - [x] e2e：上传技能包→publish→执行（含 depsDigest/签名拒绝路径）
  - [x] e2e：模型多密钥轮转（429/timeout 触发；policy_violation 不触发）
  - [x] e2e：模型向导页基本流程（smoke，保证接口连通与错误提示稳定）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 5 (仅当向导要支持多密钥选择；否则可并行)
- Task 6 depends on Task 1, Task 2, Task 3, Task 4, Task 5
