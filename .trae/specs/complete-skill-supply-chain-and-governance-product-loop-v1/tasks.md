# Tasks
- [x] Task 1: 设计并落地默认沙箱执行的运行时契约
  - [x] SubTask 1.1: 定义沙箱执行接口（输入/输出/错误分类/能力声明）
  - [x] SubTask 1.2: 落地 worker 执行路径切换：动态包默认走沙箱
  - [x] SubTask 1.3: 回归：出站/资源限制在沙箱路径一致生效

- [x] Task 2: 实现产物签名与执行前校验（供应链闭环）
  - [x] SubTask 2.1: 发布侧生成 digest + signature 并持久化 provenance 摘要
  - [x] SubTask 2.2: worker 执行前校验签名/摘要/绑定一致性并写审计
  - [x] SubTask 2.3: 回归：签名缺失/无效/不匹配时稳定拒绝

- [x] Task 3: 强制化准入 Gate（扫描/信任/评测）
  - [x] SubTask 3.1: 在 enable/release 等治理动作中加入不可绕过的 gate 校验
  - [x] SubTask 3.2: preflight 输出可解释的 gate 状态与缺失项（摘要）
  - [x] SubTask 3.3: 回归：gate 不满足时拒绝且错误码稳定

- [x] Task 4: 打通回放→评测→准入的产品工作流
  - [x] SubTask 4.1: API：从 replay 生成 EvalCase（仅摘要字段）并可绑定到 EvalSuite
  - [x] SubTask 4.2: Web：replay 页面增加“生成评测用例/触发评测/查看准入”入口
  - [x] SubTask 4.3: Web：changeset pipeline 展示 gate 缺失项并提供“触发评测”入口

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e：动态包默认沙箱执行 + 出站限制一致
  - [x] SubTask 5.2: e2e：签名校验失败阻断 enable/execute
  - [x] SubTask 5.3: e2e：回放→评测→准入路径可操作且状态可追溯

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 1, Task 2, Task 3, Task 4
