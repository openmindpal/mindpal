/**
 * Skill: embedding-provider
 *
 * 提供外部 embedding API 接入能力，支持：
 * - OpenAI embedding API
 * - 国内大模型兼容接口（智谱、百川、通义千问等）
 * - 本地模型（Ollama、LocalAI）
 *
 * **重要**：复用 model.gateway 的 connector 体系，不独立管理 API Key。
 * 通过 provider_bindings 获取 baseUrl 和 secretId，确保统一密钥管理。
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { embeddingRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "embedding.provider", version: "1.0.0" },
    layer: "extension",
    routes: ["/embedding"],
    frontend: ["/gov/embedding"],
    dependencies: ["schemas", "audit"],
    skillDependencies: ["model.gateway"], // 依赖 model.gateway 的 connector 体系
    tools: [
      {
        name: "embedding.generate",
        displayName: { "zh-CN": "生成向量", "en-US": "Generate embedding" },
        description: {
          "zh-CN": "调用外部 embedding 模型生成文本向量表示（复用 model.gateway 的 connector 配置）",
          "en-US": "Generate text embedding vector using external embedding model (reuses model.gateway connector)",
        },
        scope: "read",
        resourceType: "embedding",
        action: "generate",
        riskLevel: "low",
        inputSchema: {
          fields: {
            text: { type: "string", required: true, description: "待向量化的文本" },
            texts: { type: "array", items: { type: "string" }, description: "批量文本（与 text 二选一）" },
            model: { type: "string", description: "embedding 模型名称，如 text-embedding-ada-002" },
            bindingId: { type: "string", description: "指定 model.gateway 的 binding ID（可选，自动选择默认）" },
          },
        },
        outputSchema: {
          fields: {
            embedding: { type: "array", items: { type: "number" }, description: "单文本向量" },
            embeddings: { type: "array", items: { type: "array" }, description: "批量向量" },
            model: { type: "string" },
            usage: { type: "json" },
          },
        },
      },
      {
        name: "embedding.similarity",
        displayName: { "zh-CN": "计算相似度", "en-US": "Calculate similarity" },
        description: {
          "zh-CN": "计算两个向量或文本之间的余弦相似度",
          "en-US": "Calculate cosine similarity between two vectors or texts",
        },
        scope: "read",
        resourceType: "embedding",
        action: "similarity",
        riskLevel: "low",
        inputSchema: {
          fields: {
            vectorA: { type: "array", items: { type: "number" }, description: "向量 A" },
            vectorB: { type: "array", items: { type: "number" }, description: "向量 B" },
            textA: { type: "string", description: "文本 A（与 vectorA 二选一，需先生成向量）" },
            textB: { type: "string", description: "文本 B（与 vectorB 二选一）" },
          },
        },
        outputSchema: {
          fields: {
            similarity: { type: "number", description: "相似度分数 [0, 1]" },
          },
        },
      },
      {
        name: "embedding.bindings",
        displayName: { "zh-CN": "列出可用的 embedding 绑定", "en-US": "List available embedding bindings" },
        description: {
          "zh-CN": "列出当前租户可用于 embedding 的 model.gateway 绑定",
          "en-US": "List model.gateway bindings available for embedding in current tenant",
        },
        scope: "read",
        resourceType: "embedding",
        action: "bindings",
        riskLevel: "low",
        inputSchema: { fields: {} },
        outputSchema: {
          fields: {
            bindings: { type: "array", items: { type: "json" } },
            hint: { type: "string" },
          },
        },
      },
      {
        name: "embedding.setDefault",
        displayName: { "zh-CN": "设置默认 embedding 绑定", "en-US": "Set default embedding binding" },
        description: {
          "zh-CN": "指定用于 embedding 的默认 model.gateway 绑定",
          "en-US": "Set the default model.gateway binding for embedding operations",
        },
        scope: "write",
        resourceType: "embedding",
        action: "setDefault",
        riskLevel: "low",
        inputSchema: {
          fields: {
            bindingId: { type: "string", required: true, description: "model.gateway binding ID" },
            embeddingModel: { type: "string", description: "覆盖使用的 embedding 模型名（可选）" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            defaultBinding: { type: "json" },
          },
        },
      },
    ],
  },
  routes: embeddingRoutes,
};

export default plugin;
