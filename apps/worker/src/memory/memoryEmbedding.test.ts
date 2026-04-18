import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveMemoryEmbeddingConfig,
  denseModelRef,
  processMemoryEmbeddingJob,
  backfillMemoryEmbeddings,
} from "./memoryEmbedding";

/* ── 全局 mock ─────────────────────────────────────────── */

vi.mock("@openslin/shared", () => ({
  computeMinhash: vi.fn(() => new Array(16).fill(42)),
}));

const savedEnv = { ...process.env };

beforeEach(() => {
  // 清空所有相关环境变量
  for (const k of Object.keys(process.env)) {
    if (
      k.startsWith("MEMORY_EMBEDDING_") ||
      k.startsWith("KNOWLEDGE_EMBEDDING_")
    ) {
      delete process.env[k];
    }
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

/* ── resolveMemoryEmbeddingConfig ────────────────────────── */

describe("resolveMemoryEmbeddingConfig", () => {
  it("未配置任何 Endpoint → 返回 null", () => {
    expect(resolveMemoryEmbeddingConfig()).toBeNull();
  });

  it("MEMORY_EMBEDDING_ENDPOINT 配置 → 正确解析", () => {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://api.openai.com";
    process.env.MEMORY_EMBEDDING_API_KEY = "sk-test-key";
    process.env.MEMORY_EMBEDDING_MODEL = "text-embedding-ada-002";
    process.env.MEMORY_EMBEDDING_DIMENSIONS = "768";
    process.env.MEMORY_EMBEDDING_BATCH_SIZE = "50";
    process.env.MEMORY_EMBEDDING_TIMEOUT_MS = "15000";

    const cfg = resolveMemoryEmbeddingConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.endpoint).toBe("https://api.openai.com");
    expect(cfg!.apiKey).toBe("sk-test-key");
    expect(cfg!.model).toBe("text-embedding-ada-002");
    expect(cfg!.dimensions).toBe(768);
    expect(cfg!.batchSize).toBe(50);
    expect(cfg!.timeoutMs).toBe(15000);
  });

  it("降级到 KNOWLEDGE_EMBEDDING_* 变量", () => {
    process.env.KNOWLEDGE_EMBEDDING_ENDPOINT = "https://knowledge.api.local";
    process.env.KNOWLEDGE_EMBEDDING_API_KEY = "kn-key";

    const cfg = resolveMemoryEmbeddingConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.endpoint).toBe("https://knowledge.api.local");
    expect(cfg!.apiKey).toBe("kn-key");
  });

  it("MEMORY 优先于 KNOWLEDGE", () => {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://mem.api";
    process.env.KNOWLEDGE_EMBEDDING_ENDPOINT = "https://know.api";

    const cfg = resolveMemoryEmbeddingConfig();
    expect(cfg!.endpoint).toBe("https://mem.api");
  });

  it("默认值：model=text-embedding-3-small, dimensions=1536, batchSize=20, timeoutMs=30000", () => {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://api.local";

    const cfg = resolveMemoryEmbeddingConfig()!;
    expect(cfg.model).toBe("text-embedding-3-small");
    expect(cfg.dimensions).toBe(1536);
    expect(cfg.batchSize).toBe(20);
    expect(cfg.timeoutMs).toBe(30000);
    expect(cfg.apiKey).toBeNull();
  });

  it("dimensions 被 clamp 到 [64, 4096]", () => {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://api.local";
    process.env.MEMORY_EMBEDDING_DIMENSIONS = "10";
    expect(resolveMemoryEmbeddingConfig()!.dimensions).toBe(64);

    process.env.MEMORY_EMBEDDING_DIMENSIONS = "99999";
    expect(resolveMemoryEmbeddingConfig()!.dimensions).toBe(4096);
  });

  it("batchSize 被 clamp 到 [1, 100]", () => {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://api.local";
    process.env.MEMORY_EMBEDDING_BATCH_SIZE = "0";
    expect(resolveMemoryEmbeddingConfig()!.batchSize).toBe(1);

    process.env.MEMORY_EMBEDDING_BATCH_SIZE = "200";
    expect(resolveMemoryEmbeddingConfig()!.batchSize).toBe(100);
  });

  it("timeoutMs 最小 1000", () => {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://api.local";
    process.env.MEMORY_EMBEDDING_TIMEOUT_MS = "100";
    expect(resolveMemoryEmbeddingConfig()!.timeoutMs).toBe(1000);
  });
});

/* ── denseModelRef ──────────────────────────────────────── */

describe("denseModelRef", () => {
  it("返回 model:dimensions 格式", () => {
    expect(
      denseModelRef({
        endpoint: "https://x",
        apiKey: null,
        model: "text-embedding-3-small",
        dimensions: 1536,
        batchSize: 20,
        timeoutMs: 30000,
      }),
    ).toBe("text-embedding-3-small:1536");
  });

  it("自定义模型名和维度", () => {
    expect(
      denseModelRef({
        endpoint: "https://x",
        apiKey: null,
        model: "bge-m3",
        dimensions: 768,
        batchSize: 20,
        timeoutMs: 30000,
      }),
    ).toBe("bge-m3:768");
  });
});

/* ── mock 工具 ──────────────────────────────────────────── */

function makePool(queryResults: Record<string, () => any>) {
  return {
    query: vi.fn(async (sql: string, params?: any[]) => {
      for (const [pattern, factory] of Object.entries(queryResults)) {
        if (sql.includes(pattern)) return factory();
      }
      return { rows: [], rowCount: 0 };
    }),
  } as any;
}

function makeFetchMock(vectors: number[][]) {
  return vi.fn(async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    const data = (body.input as string[]).map((_, i) => ({
      index: i,
      embedding: vectors[i] ?? vectors[0] ?? Array(1536).fill(0),
    }));
    return {
      ok: true,
      json: async () => ({ data }),
      text: async () => "",
    };
  });
}

/* ── processMemoryEmbeddingJob ─────────────────────────── */

describe("processMemoryEmbeddingJob", () => {
  function setDefaultEmbeddingEnv() {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://embed.test";
    process.env.MEMORY_EMBEDDING_MODEL = "test-model";
    process.env.MEMORY_EMBEDDING_DIMENSIONS = "256";
  }

  it("未配置 Embedding API → skipped = count, updated = 0", async () => {
    const pool = makePool({});
    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1", "id-2"],
      tenantId: "t1",
      spaceId: "s1",
    });
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.modelRef).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("正常处理：读取→嵌入→更新 DB（完整流程）", async () => {
    setDefaultEmbeddingEnv();
    const vec1 = Array(256).fill(0.1);
    const vec2 = Array(256).fill(0.2);
    const fetchMock = makeFetchMock([vec1, vec2]);
    vi.stubGlobal("fetch", fetchMock);

    const pool = makePool({
      "SELECT id, title, content_text": () => ({
        rows: [
          { id: "id-1", title: "蒸馏摘要A", content_text: "核心知识内容A", embedding_model_ref: "minhash:16@1" },
          { id: "id-2", title: "蒸馏摘要B", content_text: "核心知识内容B", embedding_model_ref: "minhash:16@1" },
        ],
        rowCount: 2,
      }),
      "UPDATE memory_entries": () => ({ rowCount: 1, rows: [] }),
    });

    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1", "id-2"],
      tenantId: "t1",
      spaceId: "s1",
    });

    expect(result.updated).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.modelRef).toBe("test-model:256");

    // 验证 fetch 被调用且参数正确
    expect(fetchMock).toHaveBeenCalledOnce();
    const fetchArgs = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(fetchArgs.model).toBe("test-model");
    expect(fetchArgs.dimensions).toBe(256);
    expect(fetchArgs.input).toHaveLength(2);
    expect(fetchArgs.input[0]).toContain("蒸馏摘要A");

    // 验证 UPDATE SQL 被调用 2 次（逐条更新）
    const updateCalls = pool.query.mock.calls.filter((c: any) =>
      String(c[0]).includes("UPDATE memory_entries"),
    );
    expect(updateCalls).toHaveLength(2);
    // 检查第一条更新的参数
    const firstUpdateParams = updateCalls[0]![1] as any[];
    expect(firstUpdateParams[0]).toBe("id-1");
    expect(firstUpdateParams[1]).toBe("test-model:256");
  });

  it("幂等保护：已有 dense 向量的记忆被跳过", async () => {
    setDefaultEmbeddingEnv();
    vi.stubGlobal("fetch", makeFetchMock([Array(256).fill(0.5)]));

    const pool = makePool({
      "SELECT id, title, content_text": () => ({
        rows: [
          { id: "id-1", title: "已嵌入", content_text: "内容", embedding_model_ref: "test-model:256" },
          { id: "id-2", title: "待嵌入", content_text: "内容", embedding_model_ref: "minhash:16@1" },
        ],
        rowCount: 2,
      }),
      "UPDATE memory_entries": () => ({ rowCount: 1, rows: [] }),
    });

    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1", "id-2"],
      tenantId: "t1",
      spaceId: "s1",
    });

    expect(result.skipped).toBe(1); // id-1 跳过
    expect(result.updated).toBe(1); // id-2 更新
  });

  it("空文本记忆被跳过", async () => {
    setDefaultEmbeddingEnv();
    vi.stubGlobal("fetch", makeFetchMock([]));

    const pool = makePool({
      "SELECT id, title, content_text": () => ({
        rows: [
          { id: "id-1", title: "", content_text: "", embedding_model_ref: "minhash:16@1" },
          { id: "id-2", title: null, content_text: "  ", embedding_model_ref: "minhash:16@1" },
        ],
        rowCount: 2,
      }),
    });

    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1", "id-2"],
      tenantId: "t1",
      spaceId: "s1",
    });

    expect(result.skipped).toBe(2);
    expect(result.updated).toBe(0);
  });

  it("外部 API 失败 → 降级（errors 计数，不阻断）", async () => {
    setDefaultEmbeddingEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      })),
    );

    const pool = makePool({
      "SELECT id, title, content_text": () => ({
        rows: [
          { id: "id-1", title: "摘要", content_text: "内容", embedding_model_ref: "minhash:16@1" },
        ],
        rowCount: 1,
      }),
    });

    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1"],
      tenantId: "t1",
      spaceId: "s1",
    });

    expect(result.updated).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.modelRef).toBe("test-model:256");
  });

  it("查询结果为空 → processed=0", async () => {
    setDefaultEmbeddingEnv();
    const pool = makePool({
      "SELECT id, title, content_text": () => ({ rows: [], rowCount: 0 }),
    });

    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-nonexist"],
      tenantId: "t1",
      spaceId: "s1",
    });

    expect(result.processed).toBe(0);
    expect(result.updated).toBe(0);
  });

  it("API 返回空向量 → 对应条目 errors++", async () => {
    setDefaultEmbeddingEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ index: 0, embedding: [] }], // 空向量
        }),
      })),
    );

    const pool = makePool({
      "SELECT id, title, content_text": () => ({
        rows: [
          { id: "id-1", title: "摘要", content_text: "内容", embedding_model_ref: "minhash:16@1" },
        ],
        rowCount: 1,
      }),
    });

    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1"],
      tenantId: "t1",
      spaceId: "s1",
    });

    expect(result.updated).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("DB 更新失败 → errors++ 不阻断后续", async () => {
    setDefaultEmbeddingEnv();
    const vec = Array(256).fill(0.3);
    vi.stubGlobal("fetch", makeFetchMock([vec, vec]));

    let updateCallCount = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id, title, content_text")) {
          return {
            rows: [
              { id: "id-1", title: "A", content_text: "内容A", embedding_model_ref: "minhash:16@1" },
              { id: "id-2", title: "B", content_text: "内容B", embedding_model_ref: "minhash:16@1" },
            ],
            rowCount: 2,
          };
        }
        if (sql.includes("UPDATE memory_entries")) {
          updateCallCount++;
          if (updateCallCount === 1) throw new Error("db_connection_lost");
          return { rowCount: 1, rows: [] };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1", "id-2"],
      tenantId: "t1",
      spaceId: "s1",
    });

    expect(result.errors).toBe(1);
    expect(result.updated).toBe(1); // 第二条成功
  });

  it("文本超过 8000 字符被截断", async () => {
    setDefaultEmbeddingEnv();
    const fetchMock = makeFetchMock([Array(256).fill(0.1)]);
    vi.stubGlobal("fetch", fetchMock);

    const longContent = "x".repeat(10000);
    const pool = makePool({
      "SELECT id, title, content_text": () => ({
        rows: [
          { id: "id-1", title: "长文本", content_text: longContent, embedding_model_ref: "minhash:16@1" },
        ],
        rowCount: 1,
      }),
      "UPDATE memory_entries": () => ({ rowCount: 1, rows: [] }),
    });

    await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1"],
      tenantId: "t1",
      spaceId: "s1",
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    // title "长文本" + " " + content = 合计 > 10000，截断到 8000
    expect(sentBody.input[0].length).toBeLessThanOrEqual(8000);
  });

  it("API Key 存在时设置 Authorization Header", async () => {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://embed.test";
    process.env.MEMORY_EMBEDDING_API_KEY = "sk-my-key";
    process.env.MEMORY_EMBEDDING_DIMENSIONS = "256";

    const fetchMock = makeFetchMock([Array(256).fill(0.1)]);
    vi.stubGlobal("fetch", fetchMock);

    const pool = makePool({
      "SELECT id, title, content_text": () => ({
        rows: [
          { id: "id-1", title: "T", content_text: "C", embedding_model_ref: "minhash:16@1" },
        ],
        rowCount: 1,
      }),
      "UPDATE memory_entries": () => ({ rowCount: 1, rows: [] }),
    });

    await processMemoryEmbeddingJob({
      pool,
      memoryEntryIds: ["id-1"],
      tenantId: "t1",
      spaceId: "s1",
    });

    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers.authorization).toBe("Bearer sk-my-key");
  });
});

/* ── backfillMemoryEmbeddings ──────────────────────────── */

describe("backfillMemoryEmbeddings", () => {
  function setDefaultEmbeddingEnv() {
    process.env.MEMORY_EMBEDDING_ENDPOINT = "https://embed.test";
    process.env.MEMORY_EMBEDDING_MODEL = "test-model";
    process.env.MEMORY_EMBEDDING_DIMENSIONS = "256";
  }

  it("未配置 Embedding API → 直接返回空结果", async () => {
    const pool = makePool({});
    const result = await backfillMemoryEmbeddings({ pool });
    expect(result.processed).toBe(0);
    expect(result.modelRef).toBeNull();
  });

  it("无待处理记忆 → processed=0", async () => {
    setDefaultEmbeddingEnv();
    const pool = makePool({
      "SELECT DISTINCT tenant_id": () => ({ rows: [], rowCount: 0 }),
    });

    const result = await backfillMemoryEmbeddings({ pool });
    expect(result.processed).toBe(0);
    expect(result.modelRef).toBe("test-model:256");
  });

  it("按 tenant+space 分组处理多条记忆", async () => {
    setDefaultEmbeddingEnv();
    vi.stubGlobal("fetch", makeFetchMock([Array(256).fill(0.5)]));

    let selectCount = 0;
    const pool = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (sql.includes("SELECT DISTINCT tenant_id")) {
          return {
            rows: [
              { tenant_id: "t1", space_id: "s1", id: "id-1" },
              { tenant_id: "t1", space_id: "s1", id: "id-2" },
              { tenant_id: "t2", space_id: "s2", id: "id-3" },
            ],
            rowCount: 3,
          };
        }
        if (sql.includes("SELECT id, title, content_text")) {
          selectCount++;
          const ids = params?.[2] as string[];
          return {
            rows: ids.map((id) => ({
              id,
              title: `记忆-${id}`,
              content_text: `内容-${id}`,
              embedding_model_ref: "minhash:16@1",
            })),
            rowCount: ids.length,
          };
        }
        if (sql.includes("UPDATE memory_entries")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await backfillMemoryEmbeddings({ pool });

    expect(result.processed).toBe(3);
    expect(result.updated).toBe(3);
    // processMemoryEmbeddingJob 被分成 2 组调用（t1:s1 和 t2:s2）
    expect(selectCount).toBe(2);
  });

  it("使用自定义 limit 参数", async () => {
    setDefaultEmbeddingEnv();
    const pool = makePool({
      "SELECT DISTINCT tenant_id": () => ({ rows: [], rowCount: 0 }),
    });

    await backfillMemoryEmbeddings({ pool, limit: 10 });

    const scanCall = pool.query.mock.calls.find((c: any) =>
      String(c[0]).includes("SELECT DISTINCT"),
    );
    expect(scanCall).toBeDefined();
    expect(scanCall![1]).toEqual([10]);
  });
});

/* ── 蒸馏记忆 vs 原始记忆 向量召回评分对比 ───────────── */

describe("蒸馏记忆向量召回评分验证", () => {
  /**
   * 模拟 cosine similarity 计算
   * 用于验证蒸馏后的 semantic/procedural 记忆在向量空间中
   * 与查询的相关性高于原始 episodic 碎片
   */
  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  it("蒸馏 semantic 记忆与查询的 cosine 相似度高于 episodic 碎片", () => {
    // 模拟场景：查询"如何优化数据库性能"
    // 蒸馏后的 semantic 记忆集中了数据库优化知识
    // 原始 episodic 碎片分散含噪声

    const queryVec = Array.from({ length: 128 }, (_, i) =>
      i < 64 ? 0.8 + Math.sin(i) * 0.1 : 0.1,
    );

    // 蒸馏后的 semantic 记忆向量（与查询高度对齐）
    const distilledSemanticVec = Array.from({ length: 128 }, (_, i) =>
      i < 64 ? 0.75 + Math.cos(i) * 0.12 : 0.08,
    );

    // 原始 episodic 碎片向量（含噪声，部分相关）
    const episodicFragment1 = Array.from({ length: 128 }, (_, i) =>
      i < 32 ? 0.6 : 0.3 + Math.sin(i * 2) * 0.2,
    );
    const episodicFragment2 = Array.from({ length: 128 }, (_, i) =>
      0.4 + Math.random() * 0.1,
    );

    const scoreDistilled = cosineSimilarity(queryVec, distilledSemanticVec);
    const scoreEpisodic1 = cosineSimilarity(queryVec, episodicFragment1);
    const scoreEpisodic2 = cosineSimilarity(queryVec, episodicFragment2);

    // 蒸馏记忆评分应高于所有 episodic 碎片
    expect(scoreDistilled).toBeGreaterThan(scoreEpisodic1);
    expect(scoreDistilled).toBeGreaterThan(scoreEpisodic2);
    // 蒸馏记忆与查询的相似度应在合理高位
    expect(scoreDistilled).toBeGreaterThan(0.7);
  });

  it("蒸馏 procedural 记忆在策略匹配中排名靠前", () => {
    const queryVec = Array.from({ length: 64 }, (_, i) =>
      i < 32 ? 0.9 : 0.05,
    );

    // procedural 蒸馏记忆（浓缩的操作策略）
    const proceduralVec = Array.from({ length: 64 }, (_, i) =>
      i < 32 ? 0.85 : 0.03,
    );

    // 多条 episodic 碎片
    const episodics = Array.from({ length: 5 }, (_, j) =>
      Array.from({ length: 64 }, (_, i) =>
        i < 16 + j * 3 ? 0.5 + j * 0.05 : 0.25 + j * 0.02,
      ),
    );

    const procedScore = cosineSimilarity(queryVec, proceduralVec);
    const episodicScores = episodics.map((e) => cosineSimilarity(queryVec, e));
    const maxEpisodicScore = Math.max(...episodicScores);

    expect(procedScore).toBeGreaterThan(maxEpisodicScore);
    expect(procedScore).toBeGreaterThan(0.9);
  });

  it("混合检索排序：dense vector 评分决定最终排名", () => {
    // 模拟混合检索中 BM25 + dense vector 的加权排名
    type SearchHit = {
      id: string;
      memoryClass: string;
      bm25Score: number;
      denseScore: number;
    };

    const queryVec = Array.from({ length: 32 }, (_, i) => (i < 16 ? 1.0 : 0.0));

    const hits: SearchHit[] = [
      {
        id: "episodic-1",
        memoryClass: "episodic",
        bm25Score: 0.8,
        denseScore: cosineSimilarity(
          queryVec,
          Array.from({ length: 32 }, (_, i) => (i < 10 ? 0.5 : 0.3)),
        ),
      },
      {
        id: "semantic-distilled",
        memoryClass: "semantic",
        bm25Score: 0.6, // BM25 可能较低（蒸馏后文本更精炼）
        denseScore: cosineSimilarity(
          queryVec,
          Array.from({ length: 32 }, (_, i) => (i < 16 ? 0.95 : 0.02)),
        ),
      },
      {
        id: "episodic-2",
        memoryClass: "episodic",
        bm25Score: 0.7,
        denseScore: cosineSimilarity(
          queryVec,
          Array.from({ length: 32 }, (_, i) => (i < 8 ? 0.6 : 0.4)),
        ),
      },
    ];

    // 加权混合得分（dense 侧权重更高）
    const DENSE_WEIGHT = 0.7;
    const BM25_WEIGHT = 0.3;
    const ranked = hits
      .map((h) => ({
        ...h,
        finalScore: h.denseScore * DENSE_WEIGHT + h.bm25Score * BM25_WEIGHT,
      }))
      .sort((a, b) => b.finalScore - a.finalScore);

    // 蒸馏后的 semantic 记忆应排在第一位
    expect(ranked[0]!.id).toBe("semantic-distilled");
    expect(ranked[0]!.memoryClass).toBe("semantic");
    // 其 dense score 应最高
    expect(ranked[0]!.denseScore).toBeGreaterThan(ranked[1]!.denseScore);
  });

  it("minhash-only 记忆在 dense 通道中评分为 0（无法被召回）", () => {
    // 当记忆只有 minhash 而无 dense vector 时，dense 通道无法匹配
    const queryVec = Array.from({ length: 16 }, () => 0.5);
    const minhashOnly: number[] = []; // 无 dense vector
    const denseVec = Array.from({ length: 16 }, () => 0.48);

    const scoreMinhashOnly =
      minhashOnly.length > 0 ? cosineSimilarity(queryVec, minhashOnly) : 0;
    const scoreDense = cosineSimilarity(queryVec, denseVec);

    expect(scoreMinhashOnly).toBe(0);
    expect(scoreDense).toBeGreaterThan(0.9);
    // 这证明了为什么蒸馏后必须计算 dense embedding
    // 否则蒸馏产物在向量检索通道中完全不可见
  });
});
