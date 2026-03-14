# Tasks
- [x] Task 1: 在 Run 详情页实现回放（Replay）区块
  - [x] 1.1：新增回放区块 UI（加载按钮/错误展示/加载态）
  - [x] 1.2：调用 `GET /runs/:runId/replay` 并渲染 timeline 列表（时间/事件类型/关联 step）
  - [x] 1.3：提供事件详情展开（JSON 只读展示，便于复制排障）
  - [x] 1.4：提供“查看审计”入口（携带 lang；traceId 便于用户复制）

- [x] Task 2: 补齐 i18n 文案
  - [x] 2.1：为回放区块新增 locales keys（zh-CN/en-US）
  - [x] 2.2：确保 Web `check-no-zh` 通过（TS/TSX 无中文）

- [x] Task 3: 扩展端到端校验
  - [x] 3.1：扩展 `apps/web/scripts/e2e-console-mode.mjs`
    - 通过 API 创建一个产生 runId 的作业（复用现有 jobs 接口）
    - 校验 `/runs` 页面可加载
    - 校验 `/runs/:runId` 详情页可加载且包含回放区块关键文案
  - [x] 3.2：运行 `npm run test -w @openslin/web` 验证通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
