# Tasks
- [x] Task 1: 梳理并补齐开源发布基础文档
  - [x] 新增 LICENSE（默认 MIT）
  - [x] 新增 CONTRIBUTING.md / CODE_OF_CONDUCT.md / SECURITY.md
  - [x] README.md 补充架构索引与安全提示
- [x] Task 2: 增加基础 CI 工作流（GitHub Actions）
  - [x] 新增 .github/workflows/ci.yml（安装→测试→构建检查）
  - [x] 确保不依赖真实 secret
- [x] Task 3: 增加最小敏感信息检查（V1）
  - [x] 增加规则扫描（例如 grep/脚本）并在 CI 中运行
  - [x] 覆盖 .env/.pem/private key/token 常见模式

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
