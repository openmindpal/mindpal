# Tasks

* [x] Task 1: 扩展模型绑定以支持 Base URL

  * [x] 为 provider\_bindings 增加 baseUrl（或等价字段）并完成迁移

  * [x] 调整 `/models/chat` 在 provider=openai 时优先使用 binding.baseUrl

  * [x] 调整出站白名单校验：基于 binding.baseUrl 的 host

* [x] Task 2: 设计并新增“一键接入模型”后端接口

  * [x] 定义请求/响应结构、错误码与审计点

  * [x] 解析并规范化 baseUrl（提取 host 并落入 egressPolicy.allowedDomains）

  * [x] 创建/复用 connector instance，创建 secret，创建 binding（含 provider/model/baseUrl）

  * [x] 保证原子性与幂等（失败不留半成品；同幂等键重放不重复创建）

* [x] Task 3: Web `/gov/models` 改为单表单接入与测试

  * [x] Provider 下拉：OpenAI 兼容、DeepSeek、混元、千问、豆包、智谱、Kimi

  * [x] 输入框：Base URL、API Key、Model Name

  * [x] 保存：调用一键接入接口并展示成功/失败与返回的 modelRef

  * [x] 测试：调用 `/models/chat` 并展示 outputText 与 traceId

* [x] Task 4: 测试与回归

  * [x] API：覆盖成功、校验失败、幂等重放、原子性（失败不留半成品）

  * [x] Model Gateway：覆盖 binding.baseUrl 路由与白名单校验

  * [x] Web/e2e：单表单保存 + 点击测试 smoke

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 2

* Task 4 depends on Task 1, Task 2, Task 3

