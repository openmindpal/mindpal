/**
 * externalKnowledgeSource.ts — 外部知识源集成
 *
 * P2-1 实现:
 *   - P2-1a: ExternalKnowledgeSource 接口 + 插件注册表
 *   - P2-1b: Web Search 适配器 (Bing/Google/SerpAPI)
 *   - P2-1c: Wikipedia/百科知识源适配器
 *   - P2-1d: 学术论文知识源适配器 (Semantic Scholar/arXiv)
 *   - P2-1e: 外部知识源编排器
 *   - P2-1f: 外部知识源治理
 *
 * @module knowledge-rag/externalKnowledgeSource
 */
import type { FastifyInstance } from "fastify";

// ═══════════════════════════════════════════════════════════════
//  P2-1a: 接口定义 + 注册表
// ═══════════════════════════════════════════════════════════════

/** 外部证据项 */
export interface ExternalEvidence {
  /** 唯一标识 */
  id: string;
  /** 标题 */
  title: string;
  /** 摘要片段 */
  snippet: string;
  /** 原始 URL */
  url: string | null;
  /** 来源类型 */
  sourceType: string;
  /** 来源名称 */
  sourceName: string;
  /** 可信度评分 (0-1) */
  trustScore: number;
  /** 发布日期 */
  publishedAt: string | null;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/** 外部知识源搜索参数 */
export interface ExternalSearchParams {
  query: string;
  limit: number;
  locale?: string;
  /** 超时 (ms) */
  timeoutMs?: number;
  /** 过滤条件 */
  filters?: Record<string, unknown>;
}

/** 外部知识源搜索结果 */
export interface ExternalSearchResult {
  evidences: ExternalEvidence[];
  latencyMs: number;
  /** 搜索是否降级 */
  degraded: boolean;
  degradeReason?: string;
  /** 费用估计 (token 数或 API 调用数) */
  costEstimate?: number;
}

/** 外部知识源接口 */
export interface ExternalKnowledgeSource {
  /** 唯一名称 */
  readonly name: string;
  /** 来源类型 */
  readonly sourceType: "web_search" | "encyclopedia" | "academic" | "custom";
  /** 是否可用 */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  /** 搜索 */
  search(params: ExternalSearchParams): Promise<ExternalSearchResult>;
}

// ── 注册表 ─────────────────────────────────────────────────────

const sourceRegistry = new Map<string, ExternalKnowledgeSource>();

export function registerExternalSource(source: ExternalKnowledgeSource): void {
  sourceRegistry.set(source.name, source);
}

export function getExternalSource(name: string): ExternalKnowledgeSource | undefined {
  return sourceRegistry.get(name);
}

export function listExternalSources(): ExternalKnowledgeSource[] {
  return Array.from(sourceRegistry.values());
}

export function unregisterExternalSource(name: string): boolean {
  return sourceRegistry.delete(name);
}

// ═══════════════════════════════════════════════════════════════
//  P2-1b: Web Search 适配器
// ═══════════════════════════════════════════════════════════════

/** Web Search 配置 */
export interface WebSearchConfig {
  provider: "bing" | "google" | "serpapi";
  apiKey: string;
  endpoint?: string;
  timeoutMs: number;
  /** 结果可信度基线 */
  baseTrustScore: number;
}

export class WebSearchSource implements ExternalKnowledgeSource {
  readonly name = "web_search";
  readonly sourceType = "web_search" as const;

  constructor(private readonly config: WebSearchConfig) {}

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      // 简单 ping — 发送轻量查询
      const result = await this.search({ query: "test", limit: 1, timeoutMs: 5000 });
      return { ok: !result.degraded, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - start, error: e?.message };
    }
  }

  async search(params: ExternalSearchParams): Promise<ExternalSearchResult> {
    const start = Date.now();
    const timeout = params.timeoutMs ?? this.config.timeoutMs;

    try {
      const { endpoint, headers, body } = this.buildRequest(params);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        return {
          evidences: [],
          latencyMs: Date.now() - start,
          degraded: true,
          degradeReason: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = await response.json();
      const evidences = this.parseResponse(data, params);

      return {
        evidences: evidences.slice(0, params.limit),
        latencyMs: Date.now() - start,
        degraded: false,
        costEstimate: 1, // 1 API call
      };
    } catch (e: any) {
      return {
        evidences: [],
        latencyMs: Date.now() - start,
        degraded: true,
        degradeReason: e?.name === "AbortError" ? "timeout" : (e?.message ?? "unknown"),
      };
    }
  }

  private buildRequest(params: ExternalSearchParams): {
    endpoint: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } {
    switch (this.config.provider) {
      case "bing":
        return {
          endpoint: this.config.endpoint ?? "https://api.bing.microsoft.com/v7.0/search",
          headers: { "Ocp-Apim-Subscription-Key": this.config.apiKey, "Content-Type": "application/json" },
          body: { q: params.query, count: params.limit, mkt: params.locale ?? "zh-CN" },
        };
      case "google":
        return {
          endpoint: this.config.endpoint ?? "https://www.googleapis.com/customsearch/v1",
          headers: { "Content-Type": "application/json" },
          body: { key: this.config.apiKey, q: params.query, num: params.limit },
        };
      case "serpapi":
        return {
          endpoint: this.config.endpoint ?? "https://serpapi.com/search",
          headers: { "Content-Type": "application/json" },
          body: { api_key: this.config.apiKey, q: params.query, num: params.limit },
        };
    }
  }

  private parseResponse(data: any, _params: ExternalSearchParams): ExternalEvidence[] {
    const results: ExternalEvidence[] = [];

    // Bing 格式
    const webPages = data?.webPages?.value ?? data?.organic_results ?? data?.items ?? [];
    for (const item of (Array.isArray(webPages) ? webPages : [])) {
      results.push({
        id: `web_${results.length}`,
        title: String(item.name ?? item.title ?? ""),
        snippet: String(item.snippet ?? item.description ?? "").slice(0, 500),
        url: String(item.url ?? item.link ?? ""),
        sourceType: "web_search",
        sourceName: this.config.provider,
        trustScore: this.config.baseTrustScore,
        publishedAt: item.datePublished ?? item.date ?? null,
      });
    }

    return results;
  }
}

// ═══════════════════════════════════════════════════════════════
//  P2-1c: Wikipedia 适配器
// ═══════════════════════════════════════════════════════════════

export interface WikipediaConfig {
  language: string;
  timeoutMs: number;
}

export class WikipediaSource implements ExternalKnowledgeSource {
  readonly name = "wikipedia";
  readonly sourceType = "encyclopedia" as const;

  constructor(private readonly config: WikipediaConfig = { language: "zh", timeoutMs: 10000 }) {}

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await fetch(`https://${this.config.language}.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json`, {
        signal: AbortSignal.timeout(5000),
      });
      return { ok: res.ok, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - start, error: e?.message };
    }
  }

  async search(params: ExternalSearchParams): Promise<ExternalSearchResult> {
    const start = Date.now();
    const lang = this.config.language;

    try {
      // Step 1: 搜索相关页面
      const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(params.query)}&srlimit=${params.limit}&format=json&origin=*`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? this.config.timeoutMs);

      const searchRes = await fetch(searchUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (!searchRes.ok) {
        return { evidences: [], latencyMs: Date.now() - start, degraded: true, degradeReason: `HTTP ${searchRes.status}` };
      }

      const searchData = await searchRes.json();
      const pages = searchData?.query?.search ?? [];

      // Step 2: 获取摘要
      const evidences: ExternalEvidence[] = [];
      for (const page of (Array.isArray(pages) ? pages : []).slice(0, params.limit)) {
        const snippet = String(page.snippet ?? "")
          .replace(/<[^>]+>/g, "") // 去除 HTML 标签
          .slice(0, 500);

        evidences.push({
          id: `wiki_${page.pageid}`,
          title: String(page.title ?? ""),
          snippet,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(page.title ?? ""))}`,
          sourceType: "encyclopedia",
          sourceName: "wikipedia",
          trustScore: 0.75, // 百科类来源较高可信度
          publishedAt: page.timestamp ?? null,
        });
      }

      return { evidences, latencyMs: Date.now() - start, degraded: false };
    } catch (e: any) {
      return { evidences: [], latencyMs: Date.now() - start, degraded: true, degradeReason: e?.message };
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  P2-1d: 学术论文知识源适配器
// ═══════════════════════════════════════════════════════════════

export interface AcademicSearchConfig {
  provider: "semantic_scholar" | "arxiv";
  apiKey?: string;
  timeoutMs: number;
}

export class AcademicSource implements ExternalKnowledgeSource {
  readonly name: string;
  readonly sourceType = "academic" as const;

  constructor(private readonly config: AcademicSearchConfig) {
    this.name = `academic_${config.provider}`;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const endpoint = this.config.provider === "semantic_scholar"
        ? "https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1"
        : "http://export.arxiv.org/api/query?search_query=test&max_results=1";
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - start, error: e?.message };
    }
  }

  async search(params: ExternalSearchParams): Promise<ExternalSearchResult> {
    const start = Date.now();

    try {
      if (this.config.provider === "semantic_scholar") {
        return this.searchSemanticScholar(params, start);
      }
      return this.searchArxiv(params, start);
    } catch (e: any) {
      return { evidences: [], latencyMs: Date.now() - start, degraded: true, degradeReason: e?.message };
    }
  }

  private async searchSemanticScholar(params: ExternalSearchParams, start: number): Promise<ExternalSearchResult> {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(params.query)}&limit=${params.limit}&fields=title,abstract,url,year,citationCount`;
    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers["x-api-key"] = this.config.apiKey;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(params.timeoutMs ?? this.config.timeoutMs),
    });

    if (!res.ok) {
      return { evidences: [], latencyMs: Date.now() - start, degraded: true, degradeReason: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const papers = data?.data ?? [];

    const evidences: ExternalEvidence[] = (Array.isArray(papers) ? papers : [])
      .slice(0, params.limit)
      .map((p: any, i: number) => ({
        id: `s2_${p.paperId ?? i}`,
        title: String(p.title ?? ""),
        snippet: String(p.abstract ?? "").slice(0, 500),
        url: p.url ?? `https://api.semanticscholar.org/paper/${p.paperId}`,
        sourceType: "academic",
        sourceName: "semantic_scholar",
        trustScore: Math.min(0.9, 0.6 + (Number(p.citationCount ?? 0) / 1000)),
        publishedAt: p.year ? `${p.year}-01-01` : null,
        metadata: { citationCount: p.citationCount, year: p.year },
      }));

    return { evidences, latencyMs: Date.now() - start, degraded: false };
  }

  private async searchArxiv(params: ExternalSearchParams, start: number): Promise<ExternalSearchResult> {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(params.query)}&max_results=${params.limit}&sortBy=relevance`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(params.timeoutMs ?? this.config.timeoutMs),
    });

    if (!res.ok) {
      return { evidences: [], latencyMs: Date.now() - start, degraded: true, degradeReason: `HTTP ${res.status}` };
    }

    const text = await res.text();
    // 简化 XML 解析 — 提取 <entry> 块
    const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];

    const evidences: ExternalEvidence[] = entries.slice(0, params.limit).map((entry, i) => {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? "";
      const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? `arxiv_${i}`;
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? null;

      return {
        id: `arxiv_${id.split("/").pop() ?? i}`,
        title: title.replace(/\s+/g, " "),
        snippet: summary.replace(/\s+/g, " ").slice(0, 500),
        url: id.startsWith("http") ? id : `https://arxiv.org/abs/${id}`,
        sourceType: "academic",
        sourceName: "arxiv",
        trustScore: 0.7,
        publishedAt: published,
      };
    });

    return { evidences, latencyMs: Date.now() - start, degraded: false };
  }
}

// ═══════════════════════════════════════════════════════════════
//  P2-1e: 外部知识源编排器
// ═══════════════════════════════════════════════════════════════

/** 编排器配置 */
export interface SourceOrchestratorConfig {
  /** 启用的外部源列表 */
  enabledSources: string[];
  /** 每个源最大结果数 */
  perSourceLimit: number;
  /** 总超时 (ms) */
  totalTimeoutMs: number;
  /** 并行执行 */
  parallel: boolean;
  /** 结果融合后的最终限制 */
  finalLimit: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: SourceOrchestratorConfig = {
  enabledSources: [],
  perSourceLimit: 5,
  totalTimeoutMs: 15000,
  parallel: true,
  finalLimit: 10,
};

/** 编排器结果 */
export interface OrchestratedSearchResult {
  /** 所有来源的融合结果 */
  evidences: ExternalEvidence[];
  /** 各来源的独立结果 */
  perSource: Record<string, ExternalSearchResult>;
  /** 总延迟 */
  totalLatencyMs: number;
  /** 源计数 */
  sourcesQueried: number;
  sourcesSucceeded: number;
  sourcesDegraded: number;
}

/**
 * 并行调用多个外部知识源，结果统一融合排序
 */
export async function orchestrateExternalSources(params: {
  query: string;
  config?: Partial<SourceOrchestratorConfig>;
  locale?: string;
}): Promise<OrchestratedSearchResult> {
  const cfg = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...params.config };
  const start = Date.now();

  const sources = cfg.enabledSources
    .map(name => getExternalSource(name))
    .filter(Boolean) as ExternalKnowledgeSource[];

  if (sources.length === 0) {
    return {
      evidences: [],
      perSource: {},
      totalLatencyMs: 0,
      sourcesQueried: 0,
      sourcesSucceeded: 0,
      sourcesDegraded: 0,
    };
  }

  const searchParams: ExternalSearchParams = {
    query: params.query,
    limit: cfg.perSourceLimit,
    locale: params.locale,
    timeoutMs: cfg.totalTimeoutMs,
  };

  const perSource: Record<string, ExternalSearchResult> = {};
  let successCount = 0;
  let degradedCount = 0;

  if (cfg.parallel) {
    const results = await Promise.allSettled(
      sources.map(s => s.search(searchParams)),
    );
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      const result = results[i]!;
      if (result.status === "fulfilled") {
        perSource[source.name] = result.value;
        if (result.value.degraded) degradedCount++;
        else successCount++;
      } else {
        perSource[source.name] = {
          evidences: [],
          latencyMs: Date.now() - start,
          degraded: true,
          degradeReason: result.reason?.message ?? "unknown",
        };
        degradedCount++;
      }
    }
  } else {
    for (const source of sources) {
      try {
        const result = await source.search(searchParams);
        perSource[source.name] = result;
        if (result.degraded) degradedCount++;
        else successCount++;
      } catch (e: any) {
        perSource[source.name] = {
          evidences: [],
          latencyMs: Date.now() - start,
          degraded: true,
          degradeReason: e?.message,
        };
        degradedCount++;
      }
    }
  }

  // 融合并排序 — 按 trustScore 降序
  const allEvidences = Object.values(perSource)
    .flatMap(r => r.evidences)
    .sort((a, b) => b.trustScore - a.trustScore)
    .slice(0, cfg.finalLimit);

  return {
    evidences: allEvidences,
    perSource,
    totalLatencyMs: Date.now() - start,
    sourcesQueried: sources.length,
    sourcesSucceeded: successCount,
    sourcesDegraded: degradedCount,
  };
}

// ═══════════════════════════════════════════════════════════════
//  P2-1f: 外部知识源治理
// ═══════════════════════════════════════════════════════════════

/** 来源治理配置 */
export interface SourceGovernanceConfig {
  /** 敏感关键词过滤列表 */
  sensitiveKeywords: string[];
  /** 来源可信度最低阈值 */
  minTrustScore: number;
  /** 调用频率限制 (每分钟) */
  rateLimitPerMinute: number;
  /** 费用上限 (每天 API calls) */
  dailyCostLimit: number;
}

export const DEFAULT_GOVERNANCE_CONFIG: SourceGovernanceConfig = {
  sensitiveKeywords: [],
  minTrustScore: 0.3,
  rateLimitPerMinute: 60,
  dailyCostLimit: 10000,
};

/** 治理检查结果 */
export interface GovernanceCheckResult {
  allowed: boolean;
  filteredEvidences: ExternalEvidence[];
  removedCount: number;
  reasons: string[];
}

/** 调用计数器 (简单内存实现，生产环境应使用 Redis) */
const callCounters = new Map<string, { count: number; resetAt: number }>();
const dailyCallCounters = new Map<string, { count: number; resetAt: number }>();

/**
 * 对外部来源结果执行治理检查
 */
export function applyGovernance(params: {
  evidences: ExternalEvidence[];
  config?: Partial<SourceGovernanceConfig>;
}): GovernanceCheckResult {
  const cfg = { ...DEFAULT_GOVERNANCE_CONFIG, ...params.config };
  const reasons: string[] = [];
  let removedCount = 0;

  const filtered = params.evidences.filter(e => {
    // 可信度过滤
    if (e.trustScore < cfg.minTrustScore) {
      removedCount++;
      return false;
    }

    // 敏感关键词过滤
    if (cfg.sensitiveKeywords.length > 0) {
      const text = `${e.title} ${e.snippet}`.toLowerCase();
      const hasSensitive = cfg.sensitiveKeywords.some(kw => text.includes(kw.toLowerCase()));
      if (hasSensitive) {
        removedCount++;
        reasons.push(`Filtered: sensitive content in "${e.title.slice(0, 50)}"`);
        return false;
      }
    }

    return true;
  });

  // 添加来源标记
  for (const e of filtered) {
    e.metadata = { ...e.metadata, governanceChecked: true, originalSourceType: e.sourceType };
  }

  return {
    allowed: true,
    filteredEvidences: filtered,
    removedCount,
    reasons,
  };
}

/**
 * 检查调用频率限制
 */
export function checkRateLimit(sourceName: string, config?: Partial<SourceGovernanceConfig>): {
  allowed: boolean;
  remaining: number;
} {
  const cfg = { ...DEFAULT_GOVERNANCE_CONFIG, ...config };
  const now = Date.now();
  const key = sourceName;

  // 分钟级限流
  let counter = callCounters.get(key);
  if (!counter || now > counter.resetAt) {
    counter = { count: 0, resetAt: now + 60000 };
    callCounters.set(key, counter);
  }
  counter.count++;

  // 每日限流
  let daily = dailyCallCounters.get(key);
  if (!daily || now > daily.resetAt) {
    daily = { count: 0, resetAt: now + 86400000 };
    dailyCallCounters.set(key, daily);
  }
  daily.count++;

  const minuteAllowed = counter.count <= cfg.rateLimitPerMinute;
  const dailyAllowed = daily.count <= cfg.dailyCostLimit;

  return {
    allowed: minuteAllowed && dailyAllowed,
    remaining: Math.max(0, cfg.rateLimitPerMinute - counter.count),
  };
}

/**
 * 从环境变量解析外部知识源配置并自动注册
 */
export function initExternalSourcesFromEnv(): string[] {
  const registered: string[] = [];

  // Web Search
  const webProvider = process.env.EXTERNAL_WEB_SEARCH_PROVIDER as "bing" | "google" | "serpapi" | undefined;
  const webApiKey = process.env.EXTERNAL_WEB_SEARCH_API_KEY;
  if (webProvider && webApiKey) {
    registerExternalSource(new WebSearchSource({
      provider: webProvider,
      apiKey: webApiKey,
      endpoint: process.env.EXTERNAL_WEB_SEARCH_ENDPOINT,
      timeoutMs: Number(process.env.EXTERNAL_WEB_SEARCH_TIMEOUT_MS ?? 10000),
      baseTrustScore: Number(process.env.EXTERNAL_WEB_SEARCH_TRUST_SCORE ?? 0.6),
    }));
    registered.push("web_search");
  }

  // Wikipedia
  if (process.env.EXTERNAL_WIKIPEDIA_ENABLED === "1") {
    registerExternalSource(new WikipediaSource({
      language: process.env.EXTERNAL_WIKIPEDIA_LANG ?? "zh",
      timeoutMs: Number(process.env.EXTERNAL_WIKIPEDIA_TIMEOUT_MS ?? 10000),
    }));
    registered.push("wikipedia");
  }

  // Semantic Scholar
  if (process.env.EXTERNAL_SEMANTIC_SCHOLAR_ENABLED === "1") {
    registerExternalSource(new AcademicSource({
      provider: "semantic_scholar",
      apiKey: process.env.EXTERNAL_SEMANTIC_SCHOLAR_API_KEY,
      timeoutMs: Number(process.env.EXTERNAL_SEMANTIC_SCHOLAR_TIMEOUT_MS ?? 15000),
    }));
    registered.push("academic_semantic_scholar");
  }

  // arXiv
  if (process.env.EXTERNAL_ARXIV_ENABLED === "1") {
    registerExternalSource(new AcademicSource({
      provider: "arxiv",
      timeoutMs: Number(process.env.EXTERNAL_ARXIV_TIMEOUT_MS ?? 15000),
    }));
    registered.push("academic_arxiv");
  }

  return registered;
}
