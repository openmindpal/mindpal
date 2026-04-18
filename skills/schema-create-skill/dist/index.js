"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.execute = execute;
/**
 * Schema Create Skill - 通过自然语言自动创建 Schema 骨架
 *
 * 使用流程：
 * 1. 接收用户的自然语言描述
 * 2. LLM 推断 Schema 名称和实体列表
 * 3. 生成最小化 Schema 定义（空字段）
 * 4. 创建 Changeset 并添加发布项
 * 5. 返回审批链接
 */
async function execute(req) {
    const { description, schemaName: providedName, entities: providedEntities } = req.input || {};
    const apiFetch = req.context?.apiFetch;
    const locale = req.context?.locale || "zh-CN";
    if (!apiFetch) {
        throw new Error("apiFetch not available in context");
    }
    console.log("[schema.create] 开始处理:", { description, providedName });
    // Step 0: 安全检查 - 防止误操作
    const confirmFlag = req.input?.confirm;
    const isTestMode = req.input?.isTest || description.includes('测试') || description.includes('test');
    if (isTestMode && !confirmFlag) {
        console.log("[schema.create] 检测到测试模式，拒绝自动创建");
        return {
            requiresConfirmation: true,
            isTestDetected: true,
            message: `🚫 检测到测试意图\n\n` +
                `如果您确实需要创建测试 Schema，请明确说明：\n` +
                `"正式创建测试用的 xxx Schema"\n\n` +
                `或者在开发环境中使用 API 直接创建。`,
        };
    }
    if (!confirmFlag) {
        // 首次调用，返回预览让用户确认
        let previewSchemaName = providedName;
        let previewEntities = providedEntities;
        if (!previewSchemaName || !previewEntities) {
            console.log("[schema.create] 调用 LLM 推断 Schema 结构（预览模式）");
            const llmPrompt = `
你是一个 Schema 设计专家。根据以下自然语言描述，推断出合适的 Schema 结构。

用户描述：${description}

要求：
1. Schema 名称：只允许小写字母、数字和连字符，不能以数字开头（如：crm、erp、sales）
2. 实体名称：使用驼峰命名（如：customer、order、product）
3. 只显示名用中文

请返回 JSON 格式：
{
  "schemaName": "xxx",
  "schemaDisplayName": "xxx",
  "entities": [
    { "name": "xxx", "displayName": "xxx" }
  ]
}
`.trim();
            try {
                const llmRes = await apiFetch("/orchestrator/llm/chat", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        messages: [{ role: "user", content: llmPrompt }],
                        temperature: 0.3,
                    }),
                });
                if (!llmRes.ok) {
                    throw new Error(`LLM 调用失败: ${llmRes.status}`);
                }
                const llmData = await llmRes.json();
                const inferred = JSON.parse(llmData.content);
                previewSchemaName = inferred.schemaName;
                previewEntities = inferred.entities.map((e) => ({
                    name: e.name,
                    displayName: e.displayName,
                }));
                console.log("[schema.create] LLM 推断结果:", { previewSchemaName, previewEntities });
            }
            catch (err) {
                console.error("[schema.create] LLM 推断失败，使用默认值", err);
                previewSchemaName = previewSchemaName || "custom";
                previewEntities = previewEntities || [{ name: "item", displayName: "项目" }];
            }
        }
        // 返回预览，要求用户确认
        return {
            requiresConfirmation: true,
            preview: {
                schemaName: previewSchemaName,
                entities: previewEntities,
                description: description,
            },
            message: `⚠️ 即将创建 Schema，请确认：\n\n` +
                `📋 Schema 名称: ${previewSchemaName}\n` +
                `📦 实体列表: ${previewEntities.map((e) => e.displayName).join('、')}\n\n` +
                `✅ 如果确认，请回复："确认创建 ${previewSchemaName}"\n` +
                `❌ 如果取消，请回复："取消"`,
        };
    }
    console.log("[schema.create] 用户已确认，开始创建");
    // Step 1: 如果没有提供 schemaName 或 entities，调用 LLM 推断
    let schemaName = providedName;
    let entities = providedEntities;
    if (!schemaName || !entities) {
        console.log("[schema.create] 调用 LLM 推断 Schema 结构");
        const llmPrompt = `
你是一个 Schema 设计专家。根据以下自然语言描述，推断出合适的 Schema 结构。

用户描述：${description}

要求：
1. Schema 名称：只允许小写字母、数字和连字符，不能以数字开头（如：crm、erp、sales）
2. 实体名称：使用驼峰命名（如：customer、order、product）
3. 只显示名用中文

请返回 JSON 格式：
{
  "schemaName": "xxx",
  "schemaDisplayName": "xxx",
  "entities": [
    { "name": "xxx", "displayName": "xxx" }
  ]
}
`.trim();
        try {
            const llmRes = await apiFetch("/orchestrator/llm/chat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    messages: [{ role: "user", content: llmPrompt }],
                    temperature: 0.3,
                }),
            });
            if (!llmRes.ok) {
                throw new Error(`LLM 调用失败: ${llmRes.status}`);
            }
            const llmData = await llmRes.json();
            const inferred = JSON.parse(llmData.content);
            schemaName = inferred.schemaName;
            entities = inferred.entities.map((e) => ({
                name: e.name,
                displayName: e.displayName,
            }));
            console.log("[schema.create] LLM 推断结果:", { schemaName, entities });
        }
        catch (err) {
            console.error("[schema.create] LLM 推断失败，使用默认值", err);
            // 降级方案：从描述中提取关键词
            schemaName = schemaName || "custom";
            entities = entities || [{ name: "item", displayName: "项目" }];
        }
    }
    // Step 2: 构建 Schema 定义（最小化骨架，字段为空）
    const schemaDef = {
        name: schemaName,
        displayName: {
            "zh-CN": `${schemaName}管理`,
            "en-US": `${schemaName.charAt(0).toUpperCase()}${schemaName.slice(1)} Management`,
        },
        entities: entities.reduce((acc, entity) => {
            acc[entity.name] = {
                displayName: {
                    "zh-CN": entity.displayName,
                    "en-US": entity.displayName,
                },
                fields: {}, // 空字段 - 后续由 Skill 自动发现和配置
            };
            return acc;
        }, {}),
    };
    console.log("[schema.create] 生成的 Schema 定义:", JSON.stringify(schemaDef, null, 2));
    // Step 3: 创建 Changeset
    console.log("[schema.create] 创建 Changeset");
    const csRes = await apiFetch("/governance/changesets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            title: `创建 Schema: ${schemaName} - ${description}`,
            scope: "tenant",
        }),
    });
    if (!csRes.ok) {
        const error = await csRes.json().catch(() => ({}));
        throw new Error(`创建 Changeset 失败: ${JSON.stringify(error)}`);
    }
    const csData = await csRes.json();
    const changesetId = csData.changeset?.id;
    if (!changesetId) {
        throw new Error("Changeset ID 不存在");
    }
    console.log("[schema.create] Changeset 创建成功:", changesetId);
    // Step 4: 添加 Schema 发布项
    console.log("[schema.create] 添加 Schema 发布项到 Changeset");
    const itemRes = await apiFetch(`/governance/changesets/${encodeURIComponent(changesetId)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            kind: "schema.publish",
            name: schemaName,
            schemaDef,
        }),
    });
    if (!itemRes.ok) {
        const error = await itemRes.json().catch(() => ({}));
        throw new Error(`添加 Changeset 项失败: ${JSON.stringify(error)}`);
    }
    console.log("[schema.create] Schema 发布项添加成功");
    // Step 5: 返回结果
    const approvalUrl = `/gov/changesets/${encodeURIComponent(changesetId)}?lang=${locale}`;
    return {
        changesetId,
        schemaName,
        schemaDef,
        approvalUrl,
    };
}
;
