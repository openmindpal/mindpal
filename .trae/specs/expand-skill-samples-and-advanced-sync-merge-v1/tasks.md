# Tasks
- [x] Task 1: 新增多形态示例 Skill 包并打通发布启用执行闭环
  - [x] SubTask 1.1: 新增沙箱示例包（低风险、无外呼或受控外呼）
  - [x] SubTask 1.2: 新增容器示例包（演示隔离与网络策略一致性）
  - [x] SubTask 1.3: 新增远程示例包（演示 remote runner 协议与错误分类）
  - [x] SubTask 1.4: e2e：示例包 publish→enable→execute 全链路可用且审计可追溯

- [x] Task 2: 合并策略与 proposal 数据模型与算法（确定性）
  - [x] SubTask 2.1: 定义 MergeStrategy/Proposal 类型与稳定 digest 口径
  - [x] SubTask 2.2: 实现“可自动合并/可建议合并/不可合并”的策略判定与提案生成
  - [x] SubTask 2.3: 将 proposal 绑定到 mergeRun/ticket 并写入审计摘要

- [x] Task 3: 冲突修复 API 扩展（提案读取/套用）
  - [x] SubTask 3.1: ticket/mergeRun 查询返回 proposal 摘要（非破坏性扩展）
  - [x] SubTask 3.2: 新增“apply proposal”动作并生成新 mergeRun
  - [x] SubTask 3.3: e2e：自动合并与半自动合并路径可验证且 digest 可复现

- [x] Task 4: 冲突可视化页面与操作（最小闭环）
  - [x] SubTask 4.1: 冲突详情展示 base/server/client 差异摘要
  - [x] SubTask 4.2: 展示 proposal 与一键套用入口（含失败提示与审计追溯）
  - [x] SubTask 4.3: 回归：与现有 ticket 列表与 drill-down 不冲突

# Task Dependencies
- Task 3 depends on Task 2
- Task 4 depends on Task 3
