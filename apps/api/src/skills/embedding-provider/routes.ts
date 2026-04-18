/**
 * Embedding Provider Routes
 *
 * HTTP API for embedding generation.
 * **重要**：复用 model.gateway 的 connector 体系，不独立管理 API Key。
 */
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { listBindings, getBindingById } from "../model-gateway/modules/bindingRepo";
import { decryptSecretPayload } from "../../modules/secrets/envelope";
import { getSecretRecordEncryptedPayload } from "../../modules/secrets/secretRepo";

/* ── Utility: Cosine Similarity ── */

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ── OpenAI Compatible Embedding API ── */

async function callEmbeddingApi(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  texts: string[];
}): Promise<{
  embeddings: number[][];
  model: string;
  usage?: { promptTokens: number; totalTokens: number };
}> {
  const endpoint = params.baseUrl.replace(/\/$/, "") + "/embeddings";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      input: params.texts,
      model: params.model,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error: ${response.status} ${err}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  };

  const sorted = data.data.sort((a, b) => a.index - b.index);

  return {
    embeddings: sorted.map((d) => d.embedding),
    model: data.model,
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, totalTokens: data.usage.total_tokens }
      : undefined,
  };
}

/* ── Default Binding Storage ── */

async function getDefaultEmbeddingBindingId(pool: Pool, tenantId: string, spaceId: string): Promise<string | undefined> {
  try {
    const res = await pool.query(
      `SELECT value FROM tenant_settings
       WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND key = 'embedding.default_binding_id'
       LIMIT 1`,
      [tenantId, spaceId ? "space" : "tenant", spaceId || tenantId],
    );
    return res.rows[0]?.value ?? undefined;
  } catch {
    return undefined;
  }
}

async function setDefaultEmbeddingBindingId(
  pool: Pool,
  tenantId: string,
  spaceId: string,
  bindingId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, scope_type, scope_id, key, value)
     VALUES ($1, $2, $3, 'embedding.default_binding_id', $4)
     ON CONFLICT (tenant_id, scope_type, scope_id, key)
     DO UPDATE SET value = $4, updated_at = now()`,
    [tenantId, spaceId ? "space" : "tenant", spaceId || tenantId, bindingId],
  );
}

/* ── Helper: Decrypt API Key from binding ── */

async function decryptApiKeyFromBinding(params: {
  pool: Pool;
  tenantId: string;
  masterKey: string;
  secretId: string;
}): Promise<string> {
  const secretRecord = await getSecretRecordEncryptedPayload(params.pool, params.tenantId, params.secretId);
  if (!secretRecord) {
    throw new Error("Secret not found");
  }

  const { secret, encryptedPayload } = secretRecord;

  const decrypted = await decryptSecretPayload({
    pool: params.pool,
    tenantId: params.tenantId,
    masterKey: params.masterKey,
    scopeType: secret.scopeType,
    scopeId: secret.scopeId,
    keyVersion: secret.keyVersion,
    encFormat: secret.encFormat,
    encryptedPayload,
  });

  return decrypted.apiKey ?? "";
}

/* ── Helper: Get default embedding model based on provider ── */

function getDefaultEmbeddingModel(provider: string): string {
  const embeddingModels: Record<string, string> = {
    openai: "text-embedding-ada-002",
    openai_compatible: "text-embedding-ada-002",
    deepseek: "text-embedding-ada-002", // DeepSeek 目前不提供单独 embedding API
    zhipu: "embedding-2",
    qianwen: "text-embedding-v1",
    doubao: "doubao-embedding",
  };
  return embeddingModels[provider] ?? "text-embedding-ada-002";
}

/* ── Routes ── */

export const embeddingRoutes: FastifyPluginAsync = async (app) => {
  const pool = (app as any).db as Pool;
  const masterKey = (app as any).cfg?.secrets?.masterKey ?? "";

  /**
   * GET /embedding/bindings
   * List available model.gateway bindings for embedding
   */
  app.get("/embedding/bindings", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? (req as any).ctx?.subject?.tenantId ?? "default";
    const spaceId = (req as any).spaceId ?? (req as any).ctx?.subject?.spaceId ?? tenantId;

    const bindings = await listBindings(pool, tenantId, spaceId ? "space" : "tenant", spaceId || tenantId);

    // 筛选支持 embedding 的 provider
    const embeddingCapableProviders = ["openai_compatible", "openai", "deepseek", "zhipu", "qianwen", "doubao"];
    const filtered = bindings.filter((b) => embeddingCapableProviders.includes(b.provider));

    const defaultBindingId = await getDefaultEmbeddingBindingId(pool, tenantId, spaceId);

    return reply.send({
      bindings: filtered.map((b) => ({
        id: b.id,
        modelRef: b.modelRef,
        provider: b.provider,
        model: b.model,
        baseUrl: b.baseUrl,
        isDefault: b.id === defaultBindingId,
      })),
      hint: "这些绑定来自 model.gateway，可用于 embedding 操作。使用 embedding.setDefault 设置默认绑定。",
    });
  });

  /**
   * POST /embedding/setDefault
   * Set default binding for embedding
   */
  app.post<{
    Body: { bindingId: string; embeddingModel?: string };
  }>("/embedding/setDefault", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? (req as any).ctx?.subject?.tenantId ?? "default";
    const spaceId = (req as any).spaceId ?? (req as any).ctx?.subject?.spaceId ?? tenantId;
    const { bindingId } = req.body;

    if (!bindingId) {
      return reply.status(400).send({ error: "bindingId is required" });
    }

    // 验证 binding 存在
    const binding = await getBindingById(pool, tenantId, bindingId);
    if (!binding) {
      return reply.status(404).send({ error: "Binding not found" });
    }

    await setDefaultEmbeddingBindingId(pool, tenantId, spaceId, bindingId);

    return reply.send({
      success: true,
      defaultBinding: {
        id: binding.id,
        modelRef: binding.modelRef,
        provider: binding.provider,
        model: binding.model,
      },
    });
  });

  /**
   * POST /embedding/generate
   * Generate embeddings for text(s) using model.gateway binding
   */
  app.post<{
    Body: {
      text?: string;
      texts?: string[];
      model?: string;
      bindingId?: string;
    };
  }>("/embedding/generate", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? (req as any).ctx?.subject?.tenantId ?? "default";
    const spaceId = (req as any).spaceId ?? (req as any).ctx?.subject?.spaceId ?? tenantId;
    const { text, texts: inputTexts, model: requestedModel, bindingId: requestedBindingId } = req.body;

    // Normalize input
    const texts = inputTexts ?? (text ? [text] : []);
    if (texts.length === 0) {
      return reply.status(400).send({ error: "text or texts required" });
    }

    // 获取 binding
    let bindingId = requestedBindingId;
    if (!bindingId) {
      bindingId = await getDefaultEmbeddingBindingId(pool, tenantId, spaceId);
    }
    if (!bindingId) {
      // 自动选择第一个可用的 binding
      const bindings = await listBindings(pool, tenantId, spaceId ? "space" : "tenant", spaceId || tenantId);
      const first = bindings.find((b) => ["openai_compatible", "openai", "deepseek", "zhipu"].includes(b.provider));
      if (!first) {
        return reply.status(404).send({
          error: "No embedding-capable binding found",
          hint: "请先通过 model.gateway 接入模型，然后使用 embedding.setDefault 设置默认绑定",
        });
      }
      bindingId = first.id;
    }

    const binding = await getBindingById(pool, tenantId, bindingId);
    if (!binding) {
      return reply.status(404).send({ error: "Binding not found" });
    }

    // 获取 API Key
    const secretId = binding.secretIds[0] ?? binding.secretId;
    if (!secretId) {
      return reply.status(500).send({ error: "No secret associated with binding" });
    }

    let apiKey: string;
    try {
      apiKey = await decryptApiKeyFromBinding({ pool, tenantId, masterKey, secretId });
    } catch (err) {
      return reply.status(500).send({ error: "Failed to decrypt secret", details: String(err) });
    }

    // 确定 embedding 模型
    const embeddingModel = requestedModel ?? getDefaultEmbeddingModel(binding.provider);

    try {
      const result = await callEmbeddingApi({
        baseUrl: binding.baseUrl || "https://api.openai.com/v1",
        apiKey,
        model: embeddingModel,
        texts,
      });

      if (text && !inputTexts) {
        return reply.send({
          embedding: result.embeddings[0],
          model: result.model,
          usage: result.usage,
          bindingUsed: { id: binding.id, modelRef: binding.modelRef },
        });
      }

      return reply.send({
        embeddings: result.embeddings,
        model: result.model,
        usage: result.usage,
        bindingUsed: { id: binding.id, modelRef: binding.modelRef },
      });
    } catch (err) {
      return reply.status(500).send({
        error: "Embedding generation failed",
        details: String(err),
      });
    }
  });

  /**
   * POST /embedding/similarity
   * Calculate cosine similarity
   */
  app.post<{
    Body: {
      vectorA?: number[];
      vectorB?: number[];
      textA?: string;
      textB?: string;
    };
  }>("/embedding/similarity", async (req, reply) => {
    const { vectorA, vectorB, textA, textB } = req.body;
    const tenantId = (req as any).tenantId ?? (req as any).ctx?.subject?.tenantId ?? "default";
    const spaceId = (req as any).spaceId ?? (req as any).ctx?.subject?.spaceId ?? tenantId;

    let a = vectorA;
    let b = vectorB;

    // 如果提供文本，先生成 embedding
    if (textA && textB && (!a || !b)) {
      const bindingId = await getDefaultEmbeddingBindingId(pool, tenantId, spaceId);
      if (!bindingId) {
        return reply.status(404).send({ error: "请先设置默认 embedding 绑定" });
      }

      const binding = await getBindingById(pool, tenantId, bindingId);
      if (!binding) {
        return reply.status(404).send({ error: "Binding not found" });
      }

      const secretId = binding.secretIds[0] ?? binding.secretId;
      const apiKey = await decryptApiKeyFromBinding({ pool, tenantId, masterKey, secretId });

      const embeddingModel = getDefaultEmbeddingModel(binding.provider);
      const result = await callEmbeddingApi({
        baseUrl: binding.baseUrl || "https://api.openai.com/v1",
        apiKey,
        model: embeddingModel,
        texts: [textA, textB],
      });

      a = result.embeddings[0];
      b = result.embeddings[1];
    }

    if (!a || !b) {
      return reply.status(400).send({ error: "vectorA and vectorB (or textA and textB) required" });
    }

    try {
      const similarity = cosineSimilarity(a, b);
      return reply.send({ similarity });
    } catch (err) {
      return reply.status(400).send({ error: String(err) });
    }
  });
};
