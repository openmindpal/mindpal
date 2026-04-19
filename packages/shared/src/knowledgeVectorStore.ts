// ─── V1 类型（兼容现有代码） ─────────────────────────────────────

export type VectorStoreModeV1 = "external" | "fallback";

export type VectorStoreRefV1 = {
  mode: VectorStoreModeV1;
  impl: string;
  endpointDigest8?: string;
};

export type VectorStoreCapabilitiesV1 = {
  kind: "vectorStore.capabilities.v1";
  supportsUpsert: boolean;
  supportsDelete: boolean;
  supportsQuery: boolean;
  vectorType: "int32" | "float32";
  distance: "overlap" | "cosine" | "dot";
  maxK: number;
};

export type VectorStoreChunkEmbeddingV1 = {
  chunkId: string;
  documentId: string;
  documentVersion: number;
  embeddingModelRef: string;
  vector: number[];
  updatedAt: string;
};

export type VectorStoreQueryResultItemV1 = {
  chunkId: string;
  score: number;
};

export type VectorStoreQueryResponseV1 = {
  results: VectorStoreQueryResultItemV1[];
  degraded: boolean;
  degradeReason: string | null;
};

// ─── V2 类型（专业向量数据库集成） ────────────────────────────────

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

/** V2 向量存储引用 */
export type VectorStoreRefV2 = {
  provider: VectorStoreProvider;
  impl: string;
  endpointDigest8?: string;
  collectionName?: string;
};

/** V2 向量存储能力声明 */
export type VectorStoreCapabilitiesV2 = {
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

/** V2 单条嵌入记录 (支持元数据) */
export type VectorStoreEmbeddingV2 = {
  id: string;
  vector: number[];
  metadata: VectorMetadataPayload;
  updatedAt: string;
};

/** V2 查询请求 */
export type VectorStoreQueryV2 = {
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

/** 单个过滤条件 */
export type VectorStoreFilterCondition =
  | { field: string; match: { value: string | number | boolean } }
  | { field: string; range: { gt?: number; gte?: number; lt?: number; lte?: number } }
  | { field: string; matchAny: { values: (string | number)[] } };

/** V2 查询结果项 */
export type VectorStoreQueryResultV2 = {
  id: string;
  score: number;
  metadata?: Partial<VectorMetadataPayload>;
};

/** V2 查询响应 */
export type VectorStoreQueryResponseV2 = {
  results: VectorStoreQueryResultV2[];
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

/** V2 向量存储接口 — 统一抽象层 */
export interface VectorStoreV2 {
  /** 提供者引用 */
  readonly ref: VectorStoreRefV2;

  /** 能力声明 */
  capabilities(): VectorStoreCapabilitiesV2;

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
    embeddings: VectorStoreEmbeddingV2[];
  }): Promise<VectorStoreBatchResult>;

  batchDelete(params: {
    collection: string;
    ids: string[];
  }): Promise<VectorStoreBatchResult>;

  // ── 查询操作 ──
  query(params: {
    collection: string;
    query: VectorStoreQueryV2;
  }): Promise<VectorStoreQueryResponseV2>;

  // ── 健康检查 ──
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

/** V2 向量存储配置 */
export type VectorStoreConfigV2 =
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

