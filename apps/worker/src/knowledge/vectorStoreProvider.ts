/**
 * vectorStoreProvider.ts — 向量存储提供者统一层
 *
 * 实现 Qdrant / Milvus / External HTTP / PostgreSQL Fallback 四种后端适配器，
 * 以及配置化路由和多级降级链。
 *
 * 依赖方向：
 *   packages/shared (本文件)
 *   → worker/knowledge/vectorStore.ts
 *   → worker/knowledge/embedding.ts
 *   → api/skills/knowledge-rag/modules/vectorStore.ts
 *   → api/skills/knowledge-rag/modules/repo.ts
 */

import crypto from "node:crypto";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "worker:vectorStoreProvider" });
import type {
  VectorStoreProvider,
  VectorStoreRefV2,
  VectorStoreCapabilitiesV2,
  VectorStoreV2,
  VectorStoreConfigV2,
  VectorStoreEmbeddingV2,
  VectorStoreQueryV2,
  VectorStoreQueryResponseV2,
  VectorStoreBatchResult,
  VectorStoreCollectionInfo,
  VectorStoreFilter,
  VectorStoreFilterCondition,
  VectorStoreDegradeEvent,
  PgVectorConfig,
} from "@openslin/shared";

// ─── 工具函数 ──────────────────────────────────────────────────

function sha256Hex8(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Qdrant 适配器 ──────────────────────────────────────────────

type QdrantConfig = Extract<VectorStoreConfigV2, { provider: "qdrant" }>;

/**
 * Qdrant REST API 适配器
 * 对接 Qdrant v1.x REST API (兼容 Qdrant Cloud / 本地部署)
 */
export class QdrantVectorStore implements VectorStoreV2 {
  readonly ref: VectorStoreRefV2;
  private readonly cfg: QdrantConfig;
  private readonly baseUrl: string;

  constructor(cfg: QdrantConfig) {
    this.cfg = cfg;
    this.baseUrl = cfg.endpoint.replace(/\/+$/, "");
    this.ref = {
      provider: "qdrant",
      impl: "qdrant.rest.v1",
      endpointDigest8: sha256Hex8(cfg.endpoint),
    };
  }

  capabilities(): VectorStoreCapabilitiesV2 {
    return {
      kind: "vectorStore.capabilities.v2",
      provider: "qdrant",
      supportsBatchUpsert: true,
      supportsBatchDelete: true,
      supportsFilteredQuery: true,
      supportsMetadataFiltering: true,
      supportsCollectionManagement: true,
      supportsMultiVector: false,
      vectorType: "float32",
      distance: "cosine",
      maxK: 10000,
      maxBatchSize: 1000,
      maxVectorDimension: 65536,
    };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) h["api-key"] = this.cfg.apiKey;
    return h;
  }

  private collectionUrl(name: string): string {
    const prefix = this.cfg.collectionPrefix ?? "";
    return `${this.baseUrl}/collections/${prefix}${name}`;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal } as any);
      const text = await res.text();
      if (!res.ok) throw new Error(`qdrant_http_${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Collection 管理 ──

  async ensureCollection(params: {
    name: string;
    dimension: number;
    distance?: "cosine" | "dot" | "euclidean";
  }): Promise<{ ok: boolean; created: boolean; error?: string }> {
    const url = this.collectionUrl(params.name);
    const distMap: Record<string, string> = { cosine: "Cosine", dot: "Dot", euclidean: "Euclid" };
    const dist = distMap[params.distance ?? "cosine"] ?? "Cosine";

    try {
      // 先检查是否已存在
      const checkRes = await this.fetchJson(url, { method: "GET", headers: this.headers() });
      if (checkRes?.result?.status === "green" || checkRes?.result?.status === "yellow") {
        return { ok: true, created: false };
      }
    } catch {
      // 不存在或请求失败，尝试创建
    }

    try {
      await this.fetchJson(`${this.baseUrl}/collections/${(this.cfg.collectionPrefix ?? "") + params.name}`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          vectors: {
            size: params.dimension,
            distance: dist,
          },
          // 为元数据字段创建索引 payload schema
          optimizers_config: {
            indexing_threshold: 20000,
          },
        }),
      });

      // 创建 payload 索引（用于元数据过滤）
      const payloadFields = ["tenantId", "spaceId", "documentId", "embeddingModelRef"];
      for (const field of payloadFields) {
        try {
          await this.fetchJson(`${url}/index`, {
            method: "PUT",
            headers: this.headers(),
            body: JSON.stringify({
              field_name: field,
              field_schema: "keyword",
            }),
          });
        } catch { /* 索引创建失败不影响主流程 */ }
      }

      // documentVersion 使用 integer 索引
      try {
        await this.fetchJson(`${url}/index`, {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ field_name: "documentVersion", field_schema: "integer" }),
        });
      } catch { /* ignore */ }

      return { ok: true, created: true };
    } catch (e: any) {
      return { ok: false, created: false, error: String(e?.message ?? e) };
    }
  }

  async listCollections(): Promise<VectorStoreCollectionInfo[]> {
    try {
      const data = await this.fetchJson(`${this.baseUrl}/collections`, {
        method: "GET",
        headers: this.headers(),
      });
      const collections = Array.isArray(data?.result?.collections) ? data.result.collections : [];
      return collections.map((c: any) => ({
        name: String(c.name ?? ""),
        vectorDimension: 0, // Qdrant list 不返回维度，需单独查
        distance: "",
        pointCount: 0,
        status: "ready" as const,
      }));
    } catch {
      return [];
    }
  }

  async deleteCollection(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.fetchJson(this.collectionUrl(name), {
        method: "DELETE",
        headers: this.headers(),
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // ── 写入操作 ──

  async batchUpsert(params: {
    collection: string;
    embeddings: VectorStoreEmbeddingV2[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    const batchSize = 100;
    let totalUpserted = 0;

    try {
      for (let i = 0; i < params.embeddings.length; i += batchSize) {
        const batch = params.embeddings.slice(i, i + batchSize);
        const points = batch.map((e) => ({
          id: e.id,
          vector: e.vector,
          payload: {
            tenantId: e.metadata.tenantId,
            spaceId: e.metadata.spaceId,
            documentId: e.metadata.documentId,
            documentVersion: e.metadata.documentVersion,
            chunkIndex: e.metadata.chunkIndex ?? 0,
            embeddingModelRef: e.metadata.embeddingModelRef,
            updatedAt: e.updatedAt,
            ...(e.metadata.tags ?? {}),
          },
        }));

        await this.fetchJson(`${this.collectionUrl(params.collection)}/points`, {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ points }),
        });
        totalUpserted += batch.length;
      }
      return { ok: true, count: totalUpserted, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "qdrant" };
    } catch (e: any) {
      return { ok: false, count: totalUpserted, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "qdrant" };
    }
  }

  async batchDelete(params: {
    collection: string;
    ids: string[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    try {
      await this.fetchJson(`${this.collectionUrl(params.collection)}/points/delete`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ points: params.ids }),
      });
      return { ok: true, count: params.ids.length, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "qdrant" };
    } catch (e: any) {
      return { ok: false, count: 0, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "qdrant" };
    }
  }

  // ── 查询操作 ──

  async query(params: {
    collection: string;
    query: VectorStoreQueryV2;
  }): Promise<VectorStoreQueryResponseV2> {
    const startedAt = Date.now();
    try {
      const body: any = {
        vector: params.query.vector,
        limit: Math.min(params.query.topK, 10000),
        with_payload: true,
      };

      if (params.query.scoreThreshold != null) {
        body.score_threshold = params.query.scoreThreshold;
      }

      // 构建 Qdrant 过滤条件
      const qdrantFilter = buildQdrantFilter(params.query);
      if (qdrantFilter) body.filter = qdrantFilter;

      const data = await this.fetchJson(`${this.collectionUrl(params.collection)}/points/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      const results = Array.isArray(data?.result) ? data.result : [];
      return {
        results: results.map((r: any) => ({
          id: String(r.id ?? ""),
          score: Number(r.score ?? 0),
          metadata: r.payload ? {
            tenantId: String(r.payload.tenantId ?? ""),
            spaceId: String(r.payload.spaceId ?? ""),
            documentId: String(r.payload.documentId ?? ""),
            documentVersion: Number(r.payload.documentVersion ?? 0),
            embeddingModelRef: String(r.payload.embeddingModelRef ?? ""),
          } : undefined,
        })),
        degraded: false,
        degradeReason: null,
        latencyMs: Date.now() - startedAt,
        provider: "qdrant",
      };
    } catch (e: any) {
      return { results: [], degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "qdrant" };
    }
  }

  // ── 健康检查 ──

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      await this.fetchJson(`${this.baseUrl}/healthz`, { method: "GET", headers: this.headers() });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: String(e?.message ?? e) };
    }
  }
}

/** 将统一过滤条件转换为 Qdrant filter 格式 */
function buildQdrantFilter(query: VectorStoreQueryV2): any | null {
  const must: any[] = [];
  const mustNot: any[] = [];
  const should: any[] = [];

  // 自动注入 tenant/space 过滤
  must.push({ key: "tenantId", match: { value: query.tenantId } });
  must.push({ key: "spaceId", match: { value: query.spaceId } });

  if (query.filter) {
    if (query.filter.must) {
      for (const c of query.filter.must) must.push(filterConditionToQdrant(c));
    }
    if (query.filter.mustNot) {
      for (const c of query.filter.mustNot) mustNot.push(filterConditionToQdrant(c));
    }
    if (query.filter.should) {
      for (const c of query.filter.should) should.push(filterConditionToQdrant(c));
    }
  }

  const filter: any = {};
  if (must.length > 0) filter.must = must;
  if (mustNot.length > 0) filter.must_not = mustNot;
  if (should.length > 0) filter.should = should;
  return Object.keys(filter).length > 0 ? filter : null;
}

function filterConditionToQdrant(c: VectorStoreFilterCondition): any {
  if ("match" in c) return { key: c.field, match: { value: c.match.value } };
  if ("range" in c) return { key: c.field, range: c.range };
  if ("matchAny" in c) return { key: c.field, match: { any: c.matchAny.values } };
  return {};
}

// ─── Milvus 适配器 ──────────────────────────────────────────────

type MilvusConfig = Extract<VectorStoreConfigV2, { provider: "milvus" }>;

/**
 * Milvus REST API 适配器
 * 对接 Milvus v2.x RESTful API (兼容 Zilliz Cloud / 本地部署)
 */
export class MilvusVectorStore implements VectorStoreV2 {
  readonly ref: VectorStoreRefV2;
  private readonly cfg: MilvusConfig;
  private readonly baseUrl: string;

  constructor(cfg: MilvusConfig) {
    this.cfg = cfg;
    this.baseUrl = cfg.endpoint.replace(/\/+$/, "");
    this.ref = {
      provider: "milvus",
      impl: "milvus.rest.v2",
      endpointDigest8: sha256Hex8(cfg.endpoint),
    };
  }

  capabilities(): VectorStoreCapabilitiesV2 {
    return {
      kind: "vectorStore.capabilities.v2",
      provider: "milvus",
      supportsBatchUpsert: true,
      supportsBatchDelete: true,
      supportsFilteredQuery: true,
      supportsMetadataFiltering: true,
      supportsCollectionManagement: true,
      supportsMultiVector: false,
      vectorType: "float32",
      distance: "cosine",
      maxK: 16384,
      maxBatchSize: 1000,
      maxVectorDimension: 32768,
    };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.token) h["authorization"] = `Bearer ${this.cfg.token}`;
    return h;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal } as any);
      const text = await res.text();
      if (!res.ok) throw new Error(`milvus_http_${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  private apiUrl(path: string): string {
    return `${this.baseUrl}/v2/vectordb${path}`;
  }

  // ── Collection 管理 ──

  async ensureCollection(params: {
    name: string;
    dimension: number;
    distance?: "cosine" | "dot" | "euclidean";
  }): Promise<{ ok: boolean; created: boolean; error?: string }> {
    const metricMap: Record<string, string> = { cosine: "COSINE", dot: "IP", euclidean: "L2" };
    const metric = metricMap[params.distance ?? "cosine"] ?? "COSINE";

    // 检查是否存在
    try {
      const checkRes = await this.fetchJson(this.apiUrl("/collections/has"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          dbName: this.cfg.dbName ?? "default",
          collectionName: params.name,
        }),
      });
      if (checkRes?.data?.has === true) return { ok: true, created: false };
    } catch { /* 继续创建 */ }

    try {
      await this.fetchJson(this.apiUrl("/collections/create"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          dbName: this.cfg.dbName ?? "default",
          collectionName: params.name,
          schema: {
            autoId: false,
            enableDynamicField: true,
            fields: [
              { fieldName: "id", dataType: "VarChar", isPrimary: true, elementTypeParams: { max_length: "128" } },
              { fieldName: "vector", dataType: "FloatVector", elementTypeParams: { dim: String(params.dimension) } },
              { fieldName: "tenantId", dataType: "VarChar", elementTypeParams: { max_length: "64" } },
              { fieldName: "spaceId", dataType: "VarChar", elementTypeParams: { max_length: "64" } },
              { fieldName: "documentId", dataType: "VarChar", elementTypeParams: { max_length: "64" } },
              { fieldName: "documentVersion", dataType: "Int32" },
              { fieldName: "embeddingModelRef", dataType: "VarChar", elementTypeParams: { max_length: "128" } },
            ],
          },
          indexParams: [
            { metricType: metric, fieldName: "vector", indexName: "vector_idx", indexConfig: { index_type: "AUTOINDEX" } },
          ],
        }),
      });
      return { ok: true, created: true };
    } catch (e: any) {
      return { ok: false, created: false, error: String(e?.message ?? e) };
    }
  }

  async listCollections(): Promise<VectorStoreCollectionInfo[]> {
    try {
      const data = await this.fetchJson(this.apiUrl("/collections/list"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ dbName: this.cfg.dbName ?? "default" }),
      });
      const names = Array.isArray(data?.data) ? data.data : [];
      return names.map((n: string) => ({
        name: n,
        vectorDimension: 0,
        distance: "",
        pointCount: 0,
        status: "ready" as const,
      }));
    } catch {
      return [];
    }
  }

  async deleteCollection(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.fetchJson(this.apiUrl("/collections/drop"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ dbName: this.cfg.dbName ?? "default", collectionName: name }),
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // ── 写入操作 ──

  async batchUpsert(params: {
    collection: string;
    embeddings: VectorStoreEmbeddingV2[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    const batchSize = 100;
    let totalUpserted = 0;

    try {
      for (let i = 0; i < params.embeddings.length; i += batchSize) {
        const batch = params.embeddings.slice(i, i + batchSize);
        const data = batch.map((e) => ({
          id: e.id,
          vector: e.vector,
          tenantId: e.metadata.tenantId,
          spaceId: e.metadata.spaceId,
          documentId: e.metadata.documentId,
          documentVersion: e.metadata.documentVersion,
          embeddingModelRef: e.metadata.embeddingModelRef,
          chunkIndex: e.metadata.chunkIndex ?? 0,
          updatedAt: e.updatedAt,
        }));

        await this.fetchJson(this.apiUrl("/entities/upsert"), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            dbName: this.cfg.dbName ?? "default",
            collectionName: params.collection,
            data,
          }),
        });
        totalUpserted += batch.length;
      }
      return { ok: true, count: totalUpserted, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "milvus" };
    } catch (e: any) {
      return { ok: false, count: totalUpserted, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "milvus" };
    }
  }

  async batchDelete(params: {
    collection: string;
    ids: string[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    try {
      await this.fetchJson(this.apiUrl("/entities/delete"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          dbName: this.cfg.dbName ?? "default",
          collectionName: params.collection,
          filter: `id in [${params.ids.map(id => `"${id}"`).join(",")}]`,
        }),
      });
      return { ok: true, count: params.ids.length, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "milvus" };
    } catch (e: any) {
      return { ok: false, count: 0, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "milvus" };
    }
  }

  // ── 查询操作 ──

  async query(params: {
    collection: string;
    query: VectorStoreQueryV2;
  }): Promise<VectorStoreQueryResponseV2> {
    const startedAt = Date.now();
    try {
      const body: any = {
        dbName: this.cfg.dbName ?? "default",
        collectionName: params.collection,
        data: [params.query.vector],
        annsField: "vector",
        limit: Math.min(params.query.topK, 16384),
        outputFields: ["tenantId", "spaceId", "documentId", "documentVersion", "embeddingModelRef"],
      };

      // 构建 Milvus 过滤表达式
      const filterExpr = buildMilvusFilter(params.query);
      if (filterExpr) body.filter = filterExpr;

      const data = await this.fetchJson(this.apiUrl("/entities/search"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      const results = Array.isArray(data?.data) ? data.data : [];
      return {
        results: results.map((r: any) => ({
          id: String(r.id ?? ""),
          score: Number(r.distance ?? r.score ?? 0),
          metadata: {
            tenantId: String(r.tenantId ?? ""),
            spaceId: String(r.spaceId ?? ""),
            documentId: String(r.documentId ?? ""),
            documentVersion: Number(r.documentVersion ?? 0),
            embeddingModelRef: String(r.embeddingModelRef ?? ""),
          },
        })),
        degraded: false,
        degradeReason: null,
        latencyMs: Date.now() - startedAt,
        provider: "milvus",
      };
    } catch (e: any) {
      return { results: [], degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "milvus" };
    }
  }

  // ── 健康检查 ──

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      await this.fetchJson(`${this.baseUrl}/v2/vectordb/collections/list`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ dbName: this.cfg.dbName ?? "default" }),
      });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: String(e?.message ?? e) };
    }
  }
}

/** 将统一过滤条件转换为 Milvus 表达式 */
function buildMilvusFilter(query: VectorStoreQueryV2): string | null {
  const parts: string[] = [];
  // 自动注入 tenant/space 过滤
  parts.push(`tenantId == "${query.tenantId}"`);
  parts.push(`spaceId == "${query.spaceId}"`);

  if (query.filter?.must) {
    for (const c of query.filter.must) parts.push(filterConditionToMilvus(c));
  }
  // Milvus 不直接支持 must_not 和 should，用 NOT 和 OR 模拟
  if (query.filter?.mustNot) {
    for (const c of query.filter.mustNot) parts.push(`NOT (${filterConditionToMilvus(c)})`);
  }
  if (query.filter?.should && query.filter.should.length > 0) {
    const orParts = query.filter.should.map(c => filterConditionToMilvus(c));
    parts.push(`(${orParts.join(" OR ")})`);
  }

  return parts.length > 0 ? parts.join(" AND ") : null;
}

function filterConditionToMilvus(c: VectorStoreFilterCondition): string {
  if ("match" in c) {
    const v = typeof c.match.value === "string" ? `"${c.match.value}"` : String(c.match.value);
    return `${c.field} == ${v}`;
  }
  if ("range" in c) {
    const parts: string[] = [];
    if (c.range.gt != null) parts.push(`${c.field} > ${c.range.gt}`);
    if (c.range.gte != null) parts.push(`${c.field} >= ${c.range.gte}`);
    if (c.range.lt != null) parts.push(`${c.field} < ${c.range.lt}`);
    if (c.range.lte != null) parts.push(`${c.field} <= ${c.range.lte}`);
    return parts.join(" AND ");
  }
  if ("matchAny" in c) {
    const vals = c.matchAny.values.map(v => typeof v === "string" ? `"${v}"` : String(v));
    return `${c.field} in [${vals.join(",")}]`;
  }
  return "true";
}

// ─── pgvector (PostgreSQL) 适配器 ─────────────────────────────────

type PgVectorStoreConfig = Extract<VectorStoreConfigV2, { provider: "pgvector" }>;

/**
 * pgvector 适配器
 * 通过 PostgreSQL pgvector 扩展实现 V2 向量存储接口。
 * 使用 pg Pool 直连数据库，无需额外服务。
 */
export class PgVectorProvider implements VectorStoreV2 {
  readonly ref: VectorStoreRefV2;
  private readonly cfg: PgVectorStoreConfig;
  private readonly pgConfig: PgVectorConfig;
  /** 动态导入的 pg Pool，延迟初始化 */
  private _pool: any | null = null;

  constructor(cfg: PgVectorStoreConfig) {
    this.cfg = cfg;
    this.pgConfig = cfg.config;
    this.ref = {
      provider: "pgvector",
      impl: "pgvector.pg.v1",
      endpointDigest8: sha256Hex8(cfg.connectionString),
    };
  }

  private async getPool(): Promise<any> {
    if (this._pool) return this._pool;
    try {
      const pg = await import("pg");
      const Pool = pg.default?.Pool ?? pg.Pool;
      this._pool = new Pool({ connectionString: this.cfg.connectionString, max: 5 });
      return this._pool;
    } catch (e: any) {
      throw new Error(`pgvector: failed to initialize pg Pool: ${e?.message}`);
    }
  }

  capabilities(): VectorStoreCapabilitiesV2 {
    return {
      kind: "vectorStore.capabilities.v2",
      provider: "pgvector",
      supportsBatchUpsert: true,
      supportsBatchDelete: true,
      supportsFilteredQuery: true,
      supportsMetadataFiltering: true,
      supportsCollectionManagement: true,
      supportsMultiVector: false,
      vectorType: "float32",
      distance: this.pgConfig.distanceMetric === "l2" ? "euclidean" : this.pgConfig.distanceMetric === "inner_product" ? "dot" : "cosine",
      maxK: 10000,
      maxBatchSize: 1000,
      maxVectorDimension: 16000,
    };
  }

  private distanceOp(): string {
    switch (this.pgConfig.distanceMetric) {
      case "l2": return "<->";
      case "inner_product": return "<#>";
      case "cosine":
      default: return "<=>";
    }
  }

  private indexOpsClass(): string {
    switch (this.pgConfig.distanceMetric) {
      case "l2": return "vector_l2_ops";
      case "inner_product": return "vector_ip_ops";
      case "cosine":
      default: return "vector_cosine_ops";
    }
  }

  // ── Collection 管理 ──

  async ensureCollection(params: {
    name: string;
    dimension: number;
    distance?: "cosine" | "dot" | "euclidean";
  }): Promise<{ ok: boolean; created: boolean; error?: string }> {
    const pool = await this.getPool();
    const tableName = `${params.name}_vectors`;
    const dim = params.dimension || this.pgConfig.dimensions;
    try {
      // 1. 启用 pgvector 扩展
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

      // 2. 创建向量表
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content_ref UUID NOT NULL,
          embedding vector(${dim}),
          metadata JSONB,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `);

      // 3. 创建索引
      const opsClass = this.indexOpsClass();
      if (this.pgConfig.indexType === "hnsw") {
        const m = this.pgConfig.m ?? 16;
        const efC = this.pgConfig.efConstruction ?? 64;
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_${tableName}_hnsw
          ON ${tableName} USING hnsw (embedding ${opsClass})
          WITH (m = ${m}, ef_construction = ${efC})
        `);
      } else {
        const lists = this.pgConfig.lists ?? 100;
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_${tableName}_ivfflat
          ON ${tableName} USING ivfflat (embedding ${opsClass})
          WITH (lists = ${lists})
        `);
      }

      // 4. content_ref 索引
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_${tableName}_content_ref ON ${tableName}(content_ref)`);

      return { ok: true, created: true };
    } catch (e: any) {
      _logger.warn("pgvector ensureCollection failed", { table: tableName, error: e?.message });
      return { ok: false, created: false, error: String(e?.message ?? e) };
    }
  }

  async listCollections(): Promise<VectorStoreCollectionInfo[]> {
    try {
      const pool = await this.getPool();
      const res = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '%_vectors'`
      );
      return (res.rows as any[]).map((r: any) => ({
        name: String(r.tablename).replace(/_vectors$/, ""),
        vectorDimension: this.pgConfig.dimensions,
        distance: this.pgConfig.distanceMetric,
        pointCount: 0,
        status: "ready" as const,
      }));
    } catch {
      return [];
    }
  }

  async deleteCollection(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const pool = await this.getPool();
      await pool.query(`DROP TABLE IF EXISTS ${name}_vectors CASCADE`);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // ── 写入操作 ──

  async batchUpsert(params: {
    collection: string;
    embeddings: VectorStoreEmbeddingV2[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    const tableName = `${params.collection}_vectors`;
    const pool = await this.getPool();
    let totalUpserted = 0;

    try {
      for (const e of params.embeddings) {
        const vecStr = `[${e.vector.join(",")}]`;
        await pool.query(
          `INSERT INTO ${tableName} (id, content_ref, embedding, metadata, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::vector, $4::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET embedding = $3::vector, metadata = $4::jsonb, updated_at = now()`,
          [e.id, e.metadata.documentId, vecStr, JSON.stringify(e.metadata)],
        );
        totalUpserted++;
      }
      _logger.info("pgvector batchUpsert completed", { collection: params.collection, count: totalUpserted, latencyMs: Date.now() - startedAt });
      return { ok: true, count: totalUpserted, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "pgvector" };
    } catch (e: any) {
      _logger.warn("pgvector batchUpsert failed", { collection: params.collection, error: e?.message, latencyMs: Date.now() - startedAt });
      return { ok: false, count: totalUpserted, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "pgvector" };
    }
  }

  async batchDelete(params: {
    collection: string;
    ids: string[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    const tableName = `${params.collection}_vectors`;
    try {
      const pool = await this.getPool();
      await pool.query(`DELETE FROM ${tableName} WHERE id = ANY($1::uuid[])`, [params.ids]);
      return { ok: true, count: params.ids.length, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "pgvector" };
    } catch (e: any) {
      return { ok: false, count: 0, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "pgvector" };
    }
  }

  // ── 查询操作 ──

  async query(params: {
    collection: string;
    query: VectorStoreQueryV2;
  }): Promise<VectorStoreQueryResponseV2> {
    const startedAt = Date.now();
    const tableName = `${params.collection}_vectors`;
    const op = this.distanceOp();
    const pool = await this.getPool();

    try {
      const vecStr = `[${params.query.vector.join(",")}]`;
      const topK = Math.min(params.query.topK, 10000);

      // 构建可选 metadata 过滤
      let filterClause = "";
      const filterArgs: any[] = [vecStr, topK];
      let argIdx = 3;

      if (params.query.filter?.must) {
        for (const c of params.query.filter.must) {
          if ("match" in c) {
            filterClause += ` AND metadata->>'${c.field}' = $${argIdx}`;
            filterArgs.push(String(c.match.value));
            argIdx++;
          }
        }
      }

      // 构建分数表达式（cosine 距离转相似度）
      const scoreExpr = op === "<=>" ? `1 - (embedding ${op} $1::vector)` : `-(embedding ${op} $1::vector)`;

      const res = await pool.query(
        `SELECT id, content_ref, ${scoreExpr} AS score, metadata
         FROM ${tableName}
         WHERE TRUE ${filterClause}
         ORDER BY embedding ${op} $1::vector
         LIMIT $2`,
        filterArgs,
      );

      const results = (res.rows as any[]).map((r: any) => ({
        id: String(r.id),
        score: Number(r.score ?? 0),
        metadata: r.metadata ? {
          tenantId: String(r.metadata?.tenantId ?? ""),
          spaceId: String(r.metadata?.spaceId ?? ""),
          documentId: String(r.content_ref ?? r.metadata?.documentId ?? ""),
          documentVersion: Number(r.metadata?.documentVersion ?? 0),
          embeddingModelRef: String(r.metadata?.embeddingModelRef ?? ""),
        } : undefined,
      }));

      // 应用 scoreThreshold 过滤
      const filtered = params.query.scoreThreshold != null
        ? results.filter(r => r.score >= params.query.scoreThreshold!)
        : results;

      _logger.info("pgvector query completed", { collection: params.collection, topK, resultCount: filtered.length, latencyMs: Date.now() - startedAt });
      return {
        results: filtered,
        degraded: false,
        degradeReason: null,
        latencyMs: Date.now() - startedAt,
        provider: "pgvector",
      };
    } catch (e: any) {
      _logger.warn("pgvector query failed", { collection: params.collection, error: e?.message, latencyMs: Date.now() - startedAt });
      return { results: [], degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "pgvector" };
    }
  }

  // ── 健康检查 ──

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      const pool = await this.getPool();
      await pool.query("SELECT 1");
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: String(e?.message ?? e) };
    }
  }
}

// ─── External HTTP 适配器 (V2 包装) ──────────────────────────────

type ExternalConfig = Extract<VectorStoreConfigV2, { provider: "external" }>;

/**
 * External HTTP 向量存储 V2 适配器
 * 兼容已有的 External HTTP 协议，并扩展 V2 能力
 */
export class ExternalHttpVectorStore implements VectorStoreV2 {
  readonly ref: VectorStoreRefV2;
  private readonly cfg: ExternalConfig;

  constructor(cfg: ExternalConfig) {
    this.cfg = cfg;
    this.ref = {
      provider: "external",
      impl: "external.http.v2",
      endpointDigest8: sha256Hex8(cfg.endpoint),
    };
  }

  capabilities(): VectorStoreCapabilitiesV2 {
    return {
      kind: "vectorStore.capabilities.v2",
      provider: "external",
      supportsBatchUpsert: true,
      supportsBatchDelete: true,
      supportsFilteredQuery: false,
      supportsMetadataFiltering: false,
      supportsCollectionManagement: false,
      supportsMultiVector: false,
      vectorType: "int32",
      distance: "overlap",
      maxK: 200,
      maxBatchSize: 500,
      maxVectorDimension: 65536,
    };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.bearerToken) h["authorization"] = `Bearer ${this.cfg.bearerToken}`;
    return h;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal } as any);
      const text = await res.text();
      if (!res.ok) throw new Error(`external_http_${res.status}`);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureCollection(_params: { name: string; dimension: number; distance?: "cosine" | "dot" | "euclidean" }): Promise<{ ok: boolean; created: boolean }> {
    return { ok: true, created: false }; // external 不支持 collection 管理
  }

  async listCollections(): Promise<VectorStoreCollectionInfo[]> { return []; }

  async deleteCollection(_name: string): Promise<{ ok: boolean }> { return { ok: true }; }

  async batchUpsert(params: {
    collection: string;
    embeddings: VectorStoreEmbeddingV2[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    try {
      const url = this.cfg.endpoint.replace(/\/+$/, "") + "/v1/upsert";
      const v1Embeddings = params.embeddings.map(e => ({
        chunkId: e.id,
        documentId: e.metadata.documentId,
        documentVersion: e.metadata.documentVersion,
        embeddingModelRef: e.metadata.embeddingModelRef,
        vector: e.vector,
        updatedAt: e.updatedAt,
      }));
      await this.fetchJson(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ format: "vectorStore.upsert.v1", embeddings: v1Embeddings }),
      });
      return { ok: true, count: params.embeddings.length, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "external" };
    } catch (e: any) {
      return { ok: false, count: 0, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "external" };
    }
  }

  async batchDelete(params: {
    collection: string;
    ids: string[];
  }): Promise<VectorStoreBatchResult> {
    const startedAt = Date.now();
    try {
      const url = this.cfg.endpoint.replace(/\/+$/, "") + "/v1/delete";
      await this.fetchJson(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ format: "vectorStore.delete.v1", chunkIds: params.ids }),
      });
      return { ok: true, count: params.ids.length, degraded: false, degradeReason: null, latencyMs: Date.now() - startedAt, provider: "external" };
    } catch (e: any) {
      return { ok: false, count: 0, degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "external" };
    }
  }

  async query(params: {
    collection: string;
    query: VectorStoreQueryV2;
  }): Promise<VectorStoreQueryResponseV2> {
    const startedAt = Date.now();
    try {
      const url = this.cfg.endpoint.replace(/\/+$/, "") + "/v1/query";
      const data = await this.fetchJson(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          format: "vectorStore.query.v1",
          tenantId: params.query.tenantId,
          spaceId: params.query.spaceId,
          embeddingModelRef: params.query.embeddingModelRef ?? "",
          vector: params.query.vector,
          topK: params.query.topK,
          filters: null,
        }),
      });
      const results = Array.isArray(data?.results) ? data.results : [];
      return {
        results: results.map((r: any) => ({ id: String(r.chunkId ?? r.id ?? ""), score: Number(r.score ?? 0) })).filter((r: any) => r.id),
        degraded: Boolean(data?.degraded ?? false),
        degradeReason: data?.degradeReason ? String(data.degradeReason) : null,
        latencyMs: Date.now() - startedAt,
        provider: "external",
      };
    } catch (e: any) {
      return { results: [], degraded: true, degradeReason: String(e?.message ?? e), latencyMs: Date.now() - startedAt, provider: "external" };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      await fetch(this.cfg.endpoint, { method: "HEAD" } as any);
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: String(e?.message ?? e) };
    }
  }
}

// ─── 配置化路由 + 降级链 ─────────────────────────────────────────

/** 从环境变量解析 V2 向量存储配置 */
export function resolveVectorStoreConfigV2FromEnv(): VectorStoreConfigV2 {
  const provider = String(process.env.VECTOR_STORE_PROVIDER ?? process.env.KNOWLEDGE_VECTOR_STORE_MODE ?? "").trim().toLowerCase();

  if (provider === "qdrant") {
    const endpoint = String(process.env.QDRANT_ENDPOINT ?? process.env.QDRANT_URL ?? "").trim();
    if (!endpoint) return { provider: "fallback" };
    return {
      provider: "qdrant",
      endpoint,
      apiKey: String(process.env.QDRANT_API_KEY ?? "").trim() || null,
      timeoutMs: Math.max(1000, Number(process.env.QDRANT_TIMEOUT_MS ?? 10000)),
      collectionPrefix: String(process.env.QDRANT_COLLECTION_PREFIX ?? "").trim() || undefined,
    };
  }

  if (provider === "milvus") {
    const endpoint = String(process.env.MILVUS_ENDPOINT ?? process.env.MILVUS_URL ?? "").trim();
    if (!endpoint) return { provider: "fallback" };
    return {
      provider: "milvus",
      endpoint,
      token: String(process.env.MILVUS_TOKEN ?? process.env.MILVUS_API_KEY ?? "").trim() || null,
      timeoutMs: Math.max(1000, Number(process.env.MILVUS_TIMEOUT_MS ?? 10000)),
      dbName: String(process.env.MILVUS_DB_NAME ?? "default").trim() || undefined,
    };
  }

  if (provider === "external") {
    const endpoint = String(process.env.KNOWLEDGE_VECTOR_STORE_ENDPOINT ?? "").trim();
    if (!endpoint) return { provider: "fallback" };
    return {
      provider: "external",
      endpoint,
      bearerToken: String(process.env.KNOWLEDGE_VECTOR_STORE_BEARER_TOKEN ?? "").trim() || null,
      timeoutMs: Math.max(1000, Number(process.env.KNOWLEDGE_VECTOR_STORE_TIMEOUT_MS ?? 1500)),
    };
  }

  if (provider === "pgvector") {
    const connStr = String(process.env.PGVECTOR_CONNECTION_STRING ?? process.env.DATABASE_URL ?? "").trim();
    if (!connStr) return { provider: "fallback" };
    return {
      provider: "pgvector",
      connectionString: connStr,
      timeoutMs: Math.max(1000, Number(process.env.PGVECTOR_TIMEOUT_MS ?? 10000)),
      config: {
        dimensions: Math.max(64, Math.min(16000, Number(process.env.PGVECTOR_DIMENSIONS ?? 1536))),
        distanceMetric: (String(process.env.PGVECTOR_DISTANCE_METRIC ?? "cosine").trim() as "cosine" | "l2" | "inner_product"),
        indexType: (String(process.env.PGVECTOR_INDEX_TYPE ?? "hnsw").trim() as "ivfflat" | "hnsw"),
        efConstruction: process.env.PGVECTOR_EF_CONSTRUCTION ? Number(process.env.PGVECTOR_EF_CONSTRUCTION) : undefined,
        m: process.env.PGVECTOR_M ? Number(process.env.PGVECTOR_M) : undefined,
        lists: process.env.PGVECTOR_LISTS ? Number(process.env.PGVECTOR_LISTS) : undefined,
      },
    };
  }

  return { provider: "fallback" };
}

/** 根据配置创建 V2 向量存储实例 */
export function createVectorStoreV2(cfg: VectorStoreConfigV2): VectorStoreV2 | null {
  switch (cfg.provider) {
    case "qdrant": return new QdrantVectorStore(cfg);
    case "milvus": return new MilvusVectorStore(cfg);
    case "external": return new ExternalHttpVectorStore(cfg);
    case "pgvector": return new PgVectorProvider(cfg);
    case "fallback": return null; // fallback 由降级链处理
  }
}

/**
 * 多级降级链向量存储
 *
 * 降级顺序: 专业向量DB (Qdrant/Milvus) → External HTTP → PostgreSQL MinHash fallback
 * 每级降级自动记录 degradeReason 和性能指标
 */
export class DegradingVectorStoreChain implements VectorStoreV2 {
  readonly ref: VectorStoreRefV2;
  private readonly chain: VectorStoreV2[];
  private readonly degradeLog: VectorStoreDegradeEvent[] = [];
  private readonly maxDegradeLogSize = 100;

  constructor(stores: VectorStoreV2[]) {
    this.chain = stores.filter(Boolean);
    this.ref = this.chain.length > 0
      ? { ...this.chain[0]!.ref, impl: `degrade_chain[${this.chain.map(s => s.ref.provider).join(">")}]` }
      : { provider: "fallback", impl: "empty_chain" };
  }

  capabilities(): VectorStoreCapabilitiesV2 {
    return this.chain.length > 0
      ? this.chain[0]!.capabilities()
      : {
          kind: "vectorStore.capabilities.v2", provider: "fallback",
          supportsBatchUpsert: false, supportsBatchDelete: false,
          supportsFilteredQuery: false, supportsMetadataFiltering: false,
          supportsCollectionManagement: false, supportsMultiVector: false,
          vectorType: "float32", distance: "cosine",
          maxK: 200, maxBatchSize: 0, maxVectorDimension: 0,
        };
  }

  /** 获取降级日志 */
  getDegradeLog(): readonly VectorStoreDegradeEvent[] {
    return this.degradeLog;
  }

  private recordDegrade(from: VectorStoreProvider, to: VectorStoreProvider, reason: string, latencyMs: number) {
    const event: VectorStoreDegradeEvent = { timestamp: nowIso(), fromProvider: from, toProvider: to, reason, latencyMs };
    this.degradeLog.push(event);
    if (this.degradeLog.length > this.maxDegradeLogSize) this.degradeLog.shift();
    _logger.warn("vector store degraded", { from, to, reason, latencyMs });
  }

  async ensureCollection(params: { name: string; dimension: number; distance?: "cosine" | "dot" | "euclidean" }): Promise<{ ok: boolean; created: boolean; error?: string }> {
    for (let i = 0; i < this.chain.length; i++) {
      const store = this.chain[i]!;
      try {
        const result = await store.ensureCollection(params);
        if (result.ok) return result;
      } catch (e: any) {
        if (i < this.chain.length - 1) {
          this.recordDegrade(store.ref.provider, this.chain[i + 1]!.ref.provider, `ensureCollection: ${e?.message}`, 0);
        }
      }
    }
    return { ok: false, created: false, error: "all_stores_failed" };
  }

  async listCollections(): Promise<VectorStoreCollectionInfo[]> {
    for (const store of this.chain) {
      try { return await store.listCollections(); } catch { continue; }
    }
    return [];
  }

  async deleteCollection(name: string): Promise<{ ok: boolean; error?: string }> {
    for (const store of this.chain) {
      try {
        const result = await store.deleteCollection(name);
        if (result.ok) return result;
      } catch { continue; }
    }
    return { ok: false, error: "all_stores_failed" };
  }

  async batchUpsert(params: { collection: string; embeddings: VectorStoreEmbeddingV2[] }): Promise<VectorStoreBatchResult> {
    for (let i = 0; i < this.chain.length; i++) {
      const store = this.chain[i]!;
      const startedAt = Date.now();
      try {
        const result = await store.batchUpsert(params);
        if (result.ok) return result;
        // 操作失败但未抛异常，尝试下一个
        if (i < this.chain.length - 1) {
          this.recordDegrade(store.ref.provider, this.chain[i + 1]!.ref.provider, `batchUpsert: ${result.degradeReason}`, result.latencyMs);
        }
      } catch (e: any) {
        const latencyMs = Date.now() - startedAt;
        if (i < this.chain.length - 1) {
          this.recordDegrade(store.ref.provider, this.chain[i + 1]!.ref.provider, `batchUpsert: ${e?.message}`, latencyMs);
        } else {
          return { ok: false, count: 0, degraded: true, degradeReason: String(e?.message ?? e), latencyMs, provider: store.ref.provider };
        }
      }
    }
    return { ok: false, count: 0, degraded: true, degradeReason: "all_stores_failed", latencyMs: 0, provider: "fallback" };
  }

  async batchDelete(params: { collection: string; ids: string[] }): Promise<VectorStoreBatchResult> {
    for (let i = 0; i < this.chain.length; i++) {
      const store = this.chain[i]!;
      const startedAt = Date.now();
      try {
        const result = await store.batchDelete(params);
        if (result.ok) return result;
        if (i < this.chain.length - 1) {
          this.recordDegrade(store.ref.provider, this.chain[i + 1]!.ref.provider, `batchDelete: ${result.degradeReason}`, result.latencyMs);
        }
      } catch (e: any) {
        const latencyMs = Date.now() - startedAt;
        if (i < this.chain.length - 1) {
          this.recordDegrade(store.ref.provider, this.chain[i + 1]!.ref.provider, `batchDelete: ${e?.message}`, latencyMs);
        } else {
          return { ok: false, count: 0, degraded: true, degradeReason: String(e?.message ?? e), latencyMs, provider: store.ref.provider };
        }
      }
    }
    return { ok: false, count: 0, degraded: true, degradeReason: "all_stores_failed", latencyMs: 0, provider: "fallback" };
  }

  async query(params: { collection: string; query: VectorStoreQueryV2 }): Promise<VectorStoreQueryResponseV2> {
    for (let i = 0; i < this.chain.length; i++) {
      const store = this.chain[i]!;
      const startedAt = Date.now();
      try {
        const result = await store.query(params);
        if (!result.degraded) return result;
        // 查询返回降级标记，尝试下一个
        if (i < this.chain.length - 1) {
          this.recordDegrade(store.ref.provider, this.chain[i + 1]!.ref.provider, `query: ${result.degradeReason}`, result.latencyMs);
        } else {
          return result; // 最后一个，直接返回降级结果
        }
      } catch (e: any) {
        const latencyMs = Date.now() - startedAt;
        if (i < this.chain.length - 1) {
          this.recordDegrade(store.ref.provider, this.chain[i + 1]!.ref.provider, `query: ${e?.message}`, latencyMs);
        } else {
          return { results: [], degraded: true, degradeReason: String(e?.message ?? e), latencyMs, provider: store.ref.provider };
        }
      }
    }
    return { results: [], degraded: true, degradeReason: "empty_chain", latencyMs: 0, provider: "fallback" };
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    for (const store of this.chain) {
      const result = await store.healthCheck();
      if (result.ok) return result;
    }
    return { ok: false, latencyMs: 0, error: "all_stores_unhealthy" };
  }
}

/**
 * 从环境变量创建带降级链的向量存储
 *
 * 自动构建降级顺序: primary provider → external → (internal fallback 由调用方补充)
 */
export function createVectorStoreChainFromEnv(): DegradingVectorStoreChain {
  const primaryCfg = resolveVectorStoreConfigV2FromEnv();
  const stores: VectorStoreV2[] = [];

  // 主 provider
  const primary = createVectorStoreV2(primaryCfg);
  if (primary) stores.push(primary);

  // 如果主 provider 不是 external，尝试加入 external 作为第二级降级
  if (primaryCfg.provider !== "external" && primaryCfg.provider !== "fallback") {
    const extEndpoint = String(process.env.KNOWLEDGE_VECTOR_STORE_ENDPOINT ?? "").trim();
    if (extEndpoint) {
      const extCfg: VectorStoreConfigV2 = {
        provider: "external",
        endpoint: extEndpoint,
        bearerToken: String(process.env.KNOWLEDGE_VECTOR_STORE_BEARER_TOKEN ?? "").trim() || null,
        timeoutMs: Math.max(1000, Number(process.env.KNOWLEDGE_VECTOR_STORE_TIMEOUT_MS ?? 1500)),
      };
      const ext = createVectorStoreV2(extCfg);
      if (ext) stores.push(ext);
    }
  }

  return new DegradingVectorStoreChain(stores);
}
