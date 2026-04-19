import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { memoryRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "memory.manager", version: "1.0.0" },
    routes: ["/memory"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
    tools: [
      {
        name: "memory.read",
        displayName: { "zh-CN": "读取记忆", "en-US": "Read memory" },
        description: { "zh-CN": "检索长期记忆条目", "en-US": "Search long-term memory entries" },
        scope: "read",
        resourceType: "memory",
        action: "read",
        riskLevel: "low",
        extraPermissions: [{ resourceType: "memory", action: "read" }],
        inputSchema: { fields: { query: { type: "string", required: true }, scope: { type: "string" }, type: { type: "string" }, limit: { type: "number" } } },
        outputSchema: { fields: { entries: { type: "json" } } },
      },
      {
        name: "memory.write",
        displayName: { "zh-CN": "写入/修改记忆", "en-US": "Write/Update memory" },
        description: {
          "zh-CN": "写入或修改长期记忆条目。不传 id 则新建；传入 id 则定向更新已有条目（风险等级根据记忆类型动态评估：preference=low, fact/identity=medium, relationship/credential=high）",
          "en-US": "Write or update a long-term memory entry. Omit id to create; provide id to update an existing entry (risk level dynamically evaluated by type: preference=low, fact/identity=medium, relationship/credential=high)",
        },
        scope: "write",
        resourceType: "memory",
        action: "write",
        /** 静态声明为 medium，实际运行时根据 type 动态评估；preference/setting=low, fact/identity=medium, relationship/credential/secret=high */
        riskLevel: "medium",
        extraPermissions: [{ resourceType: "memory", action: "write" }],
        inputSchema: {
          fields: {
            id: { type: "string", description: "已有记忆条目 ID（传入则更新该条目，不传则新建）" },
            scope: { type: "string" },
            type: { type: "string", required: true, description: "记忆类型：preference(low)/fact(medium)/identity(medium)/relationship(high)/credential(high)" },
            title: { type: "string" },
            contentText: { type: "string", required: true },
            writeIntent: { type: "json", required: true, description: "写入意图: {policy, approvalId?, confirmationRef?}" },
            retentionDays: { type: "number" },
            mediaRefs: { type: "json", description: "多模态附件引用列表: [{mediaId, mediaType?, caption?}]，mediaId 来自 POST /media/objects 返回值" },
          },
        },
        outputSchema: {
          fields: {
            entry: { type: "json" },
            dlpSummary: { type: "json" },
            riskEvaluation: { type: "json", description: "风险评估结果: {riskLevel, approvalRequired, riskFactors}" },
            attachments: { type: "json", description: "已关联的附件列表" },
          },
        },
      },
      {
        name: "memory.recall",
        displayName: { "zh-CN": "记忆召回", "en-US": "Memory recall" },
        description: { "zh-CN": "编排层内部记忆召回，用于对话上下文组装", "en-US": "Internal memory recall for orchestrator context assembly" },
        scope: "read",
        resourceType: "memory",
        action: "recall",
        riskLevel: "low",
        inputSchema: { fields: { query: { type: "string", required: true }, limit: { type: "number" } } },
        outputSchema: { fields: { evidence: { type: "json" }, searchMode: { type: "string" }, stageStats: { type: "json" } } },
      },
      {
        name: "task.recall",
        displayName: { "zh-CN": "任务召回", "en-US": "Task recall" },
        description: { "zh-CN": "编排层内部任务状态召回，用于跨会话任务关联", "en-US": "Internal task state recall for cross-session task association" },
        scope: "read",
        resourceType: "memory",
        action: "task_recall",
        riskLevel: "low",
        inputSchema: { fields: { limit: { type: "number" } } },
        outputSchema: { fields: { tasks: { type: "json" } } },
      },
    ],
  },
  routes: memoryRoutes,
};
export default plugin;
