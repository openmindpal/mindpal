// ─── 向量存储类型（专业向量数据库集成） ────────────────────────────────

/** 向量存储提供者类型 */
export type VectorStoreProvider = "qdrant" | "milvus" | "external" | "pgvector" | "fallback";

/** pgvector 配置接口 */
export interface PgVectorConfig {
  /** 向量维度（如 1536 for OpenAI ada-002） */
  dimensions: number;
  /** 距离度量方式 */
  distanceMetric: "cosine" | "l2" | "inner_product";
  /** 索引类型 */
  indexType: "ivfflat" | "hnsw";
  /** HNSW 构建参数 ef_construction */
  efConstruction?: number;
  /** HNSW 连接数 m */
  m?: number;
  /** IVFFlat 聚类数 lists */
  lists?: number;
}

/** 向量存储引用 */
export type VectorStoreRef = {
  provider: VectorStoreProvider;
  impl: string;
  endpointDigest8?: string;
  collectionName?: string;
};

/** 向量存储能力声明 */
export type VectorStoreCapabilities = {
  kind: "vectorStore.capabilities.v2";
  provider: VectorStoreProvider;
  supportsBatchUpsert: boolean;
  supportsBatchDelete: boolean;
  supportsFilteredQuery: boolean;
  supportsMetadataFiltering: boolean;
  supportsCollectionManagement: boolean;
  supportsMultiVector: boolean;
  vectorType: "int32" | "float32" | "float16" | "binary";
  distance: "overlap" | "cosine" | "dot" | "euclidean";
  maxK: number;
  maxBatchSize: number;
  maxVectorDimension: number;
};

/** 向量元数据 payload */
export type VectorMetadataPayload = {
  tenantId: string;
  spaceId: string;
  documentId: string;
  documentVersion: number;
  chunkIndex?: number;
  embeddingModelRef: string;
  /** 自定义标签 (key-value) */
  tags?: Record<string, string | number | boolean>;
};

/** 单条嵌入记录 (支持元数据) */
export type VectorStoreEmbedding = {
  id: string;
  vector: number[];
  metadata: VectorMetadataPayload;
  updatedAt: string;
};

/** 查询请求 */
export type VectorStoreQuery = {
  tenantId: string;
  spaceId: string;
  vector: number[];
  topK: number;
  /** 元数据过滤条件 */
  filter?: VectorStoreFilter;
  /** embedding 模型标识，用于多模型场景 */
  embeddingModelRef?: string;
  /** 最低相似度阈值，低于此值不返回 */
  scoreThreshold?: number;
};

/** 元数据过滤条件 */
export type VectorStoreFilter = {
  /** 精确匹配条件 */
  must?: VectorStoreFilterCondition[];
  /** 排除条件 */
  mustNot?: VectorStoreFilterCondition[];
  /** 至少满足一个 */
  should?: VectorStoreFilterCondition[];
};

/** 单个过滤条件（强类型联合） */
export type VectorStoreFilterCondition =
  | EqFilter
  | RangeFilter
  | InFilter
  | TextMatchFilter;

/** 精确匹配过滤 */
export type EqFilter = { field: string; match: { value: string | number | boolean } };

/** 范围过滤 */
export type RangeFilter = { field: string; range: { gt?: number; gte?: number; lt?: number; lte?: number } };

/** 多值匹配过滤 */
export type InFilter = { field: string; matchAny: { values: (string | number)[] } };

/** 文本模糊匹配过滤 */
export type TextMatchFilter = { field: string; textMatch: { query: string; mode?: "contains" | "prefix" | "exact" } };

/** 查询结果项 */
export type VectorStoreQueryResult = {
  id: string;
  score: number;
  metadata?: Partial<VectorMetadataPayload>;
};

/** 查询响应 */
export type VectorStoreQueryResponse = {
  results: VectorStoreQueryResult[];
  degraded: boolean;
  degradeReason: string | null;
  /** 查询耗时(ms) */
  latencyMs: number;
  /** 实际使用的 provider */
  provider: VectorStoreProvider;
};

/** Batch 操作结果 */
export type VectorStoreBatchResult = {
  ok: boolean;
  count: number;
  degraded: boolean;
  degradeReason: string | null;
  latencyMs: number;
  provider: VectorStoreProvider;
};

/** Collection 信息 */
export type VectorStoreCollectionInfo = {
  name: string;
  vectorDimension: number;
  distance: string;
  pointCount: number;
  status: "ready" | "creating" | "error";
};

/** 向量存储接口 — 统一抽象层 */
export interface VectorStoreInterface {
  /** 提供者引用 */
  readonly ref: VectorStoreRef;

  /** 能力声明 */
  capabilities(): VectorStoreCapabilities;

  // ── Collection 管理 ──
  ensureCollection(params: {
    name: string;
    dimension: number;
    distance?: "cosine" | "dot" | "euclidean";
  }): Promise<{ ok: boolean; created: boolean; error?: string }>;

  listCollections(): Promise<VectorStoreCollectionInfo[]>;

  deleteCollection(name: string): Promise<{ ok: boolean; error?: string }>;

  // ── 写入操作 ──
  batchUpsert(params: {
    collection: string;
    embeddings: VectorStoreEmbedding[];
  }): Promise<VectorStoreBatchResult>;

  batchDelete(params: {
    collection: string;
    ids: string[];
  }): Promise<VectorStoreBatchResult>;

  // ── 查询操作 ──
  query(params: {
    collection: string;
    query: VectorStoreQuery;
  }): Promise<VectorStoreQueryResponse>;

  // ── 健康检查 ──
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

/** 向量存储配置 */
export type VectorStoreConfig =
  | { provider: "qdrant"; endpoint: string; apiKey: string | null; timeoutMs: number; collectionPrefix?: string }
  | { provider: "milvus"; endpoint: string; token: string | null; timeoutMs: number; dbName?: string }
  | { provider: "external"; endpoint: string; bearerToken: string | null; timeoutMs: number }
  | { provider: "pgvector"; connectionString: string; config: PgVectorConfig; timeoutMs: number }
  | { provider: "fallback" };

/** 降级事件记录 */
export type VectorStoreDegradeEvent = {
  timestamp: string;
  fromProvider: VectorStoreProvider;
  toProvider: VectorStoreProvider;
  reason: string;
  latencyMs: number;
};
