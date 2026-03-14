# Tasks
- [x] Task 1: Web 端移除硬编码鉴权并加入 Token 管理
  - [x] SubTask 1.1: 增加 token 配置入口（设置页或独立页）与本地持久化
  - [x] SubTask 1.2: Web API 客户端从配置读取 token，禁止默认 Bearer
  - [x] SubTask 1.3: 401 时提示并引导重配 token

- [x] Task 2: 生产环境关键安全配置强制化
  - [x] SubTask 2.1: 生产环境禁止 API_MASTER_KEY dev fallback（启动期或运行期强制）
  - [x] SubTask 2.2: 文档补齐：生产环境必需环境变量清单

- [x] Task 3: Skill Runtime 动态 Skill 执行加固（默认拒绝 + 静态检查）
  - [x] SubTask 3.1: 定义生产环境判定与开关（显式允许非隔离执行）
  - [x] SubTask 3.2: 动态 Skill 执行前做最小静态检查（禁止模块/危险 API）
  - [x] SubTask 3.3: 拒绝路径写入 outputDigest/审计（仅规则摘要）

- [x] Task 4: Knowledge 检索排序增强与可解释摘要
  - [x] SubTask 4.1: 增强 search 排序策略（不引入新外部依赖）
  - [x] SubTask 4.2: RetrievalLog/审计增加排序摘要字段（不含敏感内容）

- [x] Task 5: 回归测试
  - [x] SubTask 5.1: Web：无 token 不携带默认 Authorization；token 生效；401 提示
  - [x] SubTask 5.2: Worker：生产环境默认拒绝动态 Skill；开关开启可执行；静态检查命中拒绝
  - [x] SubTask 5.3: API：生产环境缺 master key 的行为符合预期
  - [x] SubTask 5.4: Knowledge：检索仍返回证据链字段且排序摘要稳定

# Task Dependencies
- Task 2 depends on Task 1 (可并行实现，但建议先移除硬编码再统一安全开关说明)
- Task 5 depends on Task 1, Task 2, Task 3, Task 4
