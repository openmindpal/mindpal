# Tasks

* [x] Task 1: 扩展 CI pipeline 覆盖主要 workspace

  * [x] SubTask 1.1: 调整 `.github/workflows/ci.yml` 增加 build/test 步骤（api/worker/device-agent/web/shared）

  * [x] SubTask 1.2: 引入 matrix 或拆分 job，保证并行与可读性（保留 cache 与可复现安装方式）

  * [x] SubTask 1.3: 统一在 CI 中执行 `npm -ws run build --if-present` 作为跨模块回归底线

* [x] Task 2: 增加可选的 Web E2E job（非默认）

  * [x] SubTask 2.1: 配置 workflow\_dispatch/schedule（或环境开关）触发 Web E2E

  * [x] SubTask 2.2: 在 job 内拉起 API/Web 服务并执行 `WEB_E2E=1 npm -w apps/web test`

* [x] Task 3: 验证与文档化

  * [x] SubTask 3.1: 在 PR 场景验证：改动 shared 触发 worker/api/web build 失败能被 CI 捕获

  * [x] SubTask 3.2: 在手动触发场景验证：Web E2E job 可跑通或明确失败原因（依赖/端口/服务启动）

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 1, Task 2

