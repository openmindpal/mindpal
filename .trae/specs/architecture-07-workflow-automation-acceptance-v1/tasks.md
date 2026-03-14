# Tasks
- [x] Task 1: 审批闭环验收对齐与回归
  - [x] SubTask 1.1: 核对 tools.ts 审批分流与 idempotencyKey 规则覆盖审批路径
  - [x] SubTask 1.2: 核对 approvals.ts 审批通过后复用原 step 绑定校验与 policySnapshotRef
  - [x] SubTask 1.3: 补齐/更新 API e2e 覆盖 needs_approval → approve → 执行/拒绝

- [x] Task 2: 死信/重试/取消验收对齐与回归
  - [x] SubTask 2.1: 核对 deadletters 列表/ retry / cancel 接口与 runs.ts 运行入口联通
  - [x] SubTask 2.2: 核对审计事件覆盖 list/retry/cancel/reexec（仅摘要）
  - [x] SubTask 2.3: 补齐 API/worker/web 回归用例并确保可跑通

- [x] Task 3: SAGA（补偿/撤销）最小可用产品化
  - [x] SubTask 3.1: 明确“有副作用写操作”的识别与补偿注册数据模型
  - [x] SubTask 3.2: 补齐触发补偿的 API/治理入口与权限动作
  - [x] SubTask 3.3: 补齐补偿执行器：走 run/step 生命周期，支持 retry/cancel，写审计

- [x] Task 4: 验收清单自动化与文档
  - [x] SubTask 4.1: 将本验收点映射到 checklist，并为每条提供可重复验证步骤
  - [x] SubTask 4.2: 形成最小“验收脚本/用例集”入口（单命令可跑通关键路径）

# Task Dependencies
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 4 depends on Task 2
- Task 4 depends on Task 3
