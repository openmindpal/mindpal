# Schema Create Skill - 对话式 Schema 创建

## 📖 功能说明

通过自然语言描述自动创建 Schema 骨架，无需手动填写表单。

## 🚀 使用方式

### 方式1：前端对话（推荐）

在首页对话框中输入：

```
帮我创建一个客户管理系统的Schema，包含客户和订单两个实体
```

系统会自动：
1. ✅ LLM 推断 Schema 名称和实体结构
2. ✅ 生成最小化 Schema 定义（空字段）
3. ✅ 创建 Changeset 并添加发布项
4. ✅ 返回审批链接

### 方式2：直接调用 API

```bash
POST /skills/schema.create/execute
Content-Type: application/json

{
  "input": {
    "description": "销售管理系统，包含产品、订单、客户",
    "schemaName": "sales"  // 可选，不提供则自动生成
  }
}
```

## 💡 示例

### 示例1：简单描述
```
输入："创建一个项目管理Schema"
输出：
- schemaName: "project"
- entities: [{ name: "item", displayName: "项目" }]
```

### 示例2：详细指定
```
输入："创建CRM系统，包含客户、联系人、商机三个实体"
输出：
- schemaName: "crm"
- entities: [
    { name: "customer", displayName: "客户" },
    { name: "contact", displayName: "联系人" },
    { name: "opportunity", displayName: "商机" }
  ]
```

### 示例3：指定名称
```json
{
  "description": "企业资源计划系统",
  "schemaName": "erp",
  "entities": [
    { "name": "product", "displayName": "产品" },
    { "name": "inventory", "displayName": "库存" }
  ]
}
```

## 🔧 技术细节

### 工作流程

```
用户描述 → LLM 推断 → 生成 Schema → 创建 Changeset → 返回审批链接
```

### Schema 特点

- ✅ **最小化骨架**：只包含 Schema 名称和实体定义
- ✅ **空字段**：`fields: {}` - 后续由其他 Skill 自动发现
- ✅ **Changeset 机制**：符合治理规范，需要审批后发布

### 为什么字段为空？

符合架构设计理念：
- **Schema 层** = 元数据注册（轻量级骨架）
- **Skill 层** = 业务逻辑实现（自动发现字段）

后续可以通过：
- `schema-import-skill` - 从数据库导入字段
- `connector-sync-skill` - 从 ERP/CRM 同步字段
- AI 辅助推断字段类型

## 📝 注意事项

1. **Schema 命名规则**：只允许小写字母、数字和连字符，不能以数字开头
2. **实体命名规则**：使用驼峰命名（如 customer、orderItem）
3. **审批流程**：创建的 Schema 需要进入 Changeset 审批后才能生效
4. **权限要求**：需要 `schema:create` 权限

## 🎯 下一步

创建 Schema 后，可以：

1. **查看 Changeset**：点击返回的审批链接
2. **审批发布**：在 `/gov/changesets/{id}` 页面审批
3. **补充字段**：使用其他 Skill 自动发现和配置字段
4. **创建数据**：Schema 发布后可以开始创建实体记录


