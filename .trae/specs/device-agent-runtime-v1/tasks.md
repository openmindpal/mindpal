# Tasks
- [x] Task 1: 新增 apps/device-agent 项目与配置存储
  - [x] SubTask 1.1: 初始化 Node/TS CLI（build/run）
  - [x] SubTask 1.2: 实现本机配置文件读写（apiBase/deviceToken/deviceId 等）
  - [x] SubTask 1.3: 约束日志脱敏（禁止输出 token）

- [x] Task 2: 实现 pairing 与 heartbeat
  - [x] SubTask 2.1: `pair` 命令调用 `POST /device-agent/pair` 并落盘
  - [x] SubTask 2.2: `run` 模式定时 `POST /device-agent/heartbeat`
  - [x] SubTask 2.3: 撤销/鉴权失败时进入“需重新配对”状态

- [x] Task 3: 实现 execution loop（pending/claim/result）
  - [x] SubTask 3.1: 轮询 pending 并串行/小并发处理
  - [x] SubTask 3.2: 支持 requireUserPresence 的本机确认闸门（CLI）
  - [x] SubTask 3.3: 内置执行器：noop/echo（仅回传摘要）

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: 集成测试：mock API server 覆盖 pair/heartbeat/execution 全链路
  - [x] SubTask 4.2: README：端侧安装、pair/run 使用说明与安全约束

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
