# Tasks
- [x] Task 1: 定义 Query DSL 与输入校验
  - [x] SubTask 1.1: 定义 filters/orderBy/select/cursor 的 schema（Zod）
  - [x] SubTask 1.2: 根据 effective schema 校验字段存在性与类型匹配
  - [x] SubTask 1.3: 依据 fieldRules.read 校验可读字段约束

- [x] Task 2: 实现 queryRecords 数据访问层
  - [x] SubTask 2.1: 生成参数化 SQL（filters + order + cursor + limit）
  - [x] SubTask 2.2: 实现稳定游标（updatedAt+id）与 nextCursor

- [x] Task 3: 增加 `POST /entities/:entity/query` 路由与审计摘要
  - [x] SubTask 3.1: 鉴权与审计上下文（resourceType=entity, action=query）
  - [x] SubTask 3.2: 返回 items（payload 裁剪）与 summary（digest）

- [x] Task 4: 测试与文档
  - [x] SubTask 4.1: e2e：filters/order/select/cursor 正常返回与裁剪
  - [x] SubTask 4.2: e2e：不可读字段/非法字段/类型不匹配被拒绝
  - [x] SubTask 4.3: README 增加 query API 示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 3
