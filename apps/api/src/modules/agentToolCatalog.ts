/**
 * agentToolCatalog.ts — 工具发现与缓存模块
 *
 * 从 agentContext.ts 拆分而来，负责：
 * - 工具语义元数据推断 (inferSemanticMeta)
 * - 工具目录缓存失效 (invalidateToolCatalogQueryCache)
 * - 已启用工具发现 (discoverEnabledTools)
 */
import type { Pool } from "pg";
import type { ToolSemanticMeta } from "@mindpal/shared";
import { StructuredLogger } from "@mindpal/shared";
import {
  getLatestReleasedToolVersion,
  listToolDefinitions,
  getToolVersionByRef,
  type ToolDefinition,
  type ToolVersion,
  type ToolPolicyRule,
} from "./tools/toolRepo";
import { resolveEffectiveToolRef } from "./tools/resolve";
import { isToolEnabled } from "./governance/toolGovernanceRepo";

const _logger = new StructuredLogger({ module: "agentToolCatalog" });

// ─── 工具类型 ─────────────────────────────────────────────────────

export type EnabledTool = { name: string; toolRef: string; def: ToolDefinition; ver: ToolVersion | null };

// ─── 内部辅助 ─────────────────────────────────────────────────────

function i18nText(v: unknown, locale: string): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, string>;
    return String(obj[locale] ?? obj["zh-CN"] ?? Object.values(obj)[0] ?? "");
  }
  return String(v);
}

// ─── 工具语义元数据 ─────────────────────────────────────────────────

/** P4: 从现有工具元数据自动推断语义，显式 semantic_meta 覆盖推断值 */
export function inferSemanticMeta(def: { scope?: string | null; riskLevel?: string; category?: string; semanticMeta?: ToolSemanticMeta | null }): ToolSemanticMeta {
  const base: ToolSemanticMeta = {
    operationType: def.scope === "write" ? "write" : "read",
    precisionLevel: def.riskLevel === "high" ? "best_effort" : "exact",
    sideEffects: def.scope === "write" ? [def.category ?? "unknown"] : [],
    semanticEquivalents: [],
    notEquivalentTo: [],
  };
  if (def.semanticMeta) return { ...base, ...def.semanticMeta };
  return base;
}

// ─── 工具发现缓存 ─────────────────────────────────────────────────

const TOOLS_CATALOG_MAX_CHARS = Math.max(1000, Number(process.env.ORCHESTRATOR_TOOLS_CATALOG_MAX_CHARS) || 8000);

/**
 * P1-2 FIX: 工具发现缓存
 * 按 tenantId:spaceId:locale 缓存 discoverEnabledTools 结果，避免每次对话都完整查 DB。
 * TTL 可通过环境变量 TOOL_DISCOVERY_CACHE_TTL_MS 配置（默认 60s）。
 */
const _toolDiscoveryCache = new Map<string, { result: { catalog: string; tools: EnabledTool[] }; expiresAt: number }>();
const TOOL_DISCOVERY_CACHE_TTL_MS = Math.max(5000, Number(process.env.TOOL_DISCOVERY_CACHE_TTL_MS) || 60_000);
const TOOL_DISCOVERY_CACHE_MAX_ENTRIES = 100;

function _toolDiscoveryCacheKey(tenantId: string, spaceId: string, locale: string, category?: string, query?: string, includeHiddenTools?: boolean): string {
  return `${tenantId}:${spaceId}:${locale}:${category ?? ""}:${query ?? ""}:${includeHiddenTools ? "all" : "planner"}`;
}

// ── tool_policy_rules 缓存加载 ──
let _policyCache: ToolPolicyRule[] | null = null;
let _policyCacheAt = 0;
const POLICY_CACHE_TTL_MS = 60_000;

async function loadToolPolicyRules(pool: Pool, tenantId: string): Promise<ToolPolicyRule[]> {
  if (_policyCache && Date.now() - _policyCacheAt < POLICY_CACHE_TTL_MS) {
    return _policyCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT rule_type, match_field, match_pattern, effect, enabled
       FROM tool_policy_rules WHERE tenant_id = $1 AND enabled = true`,
      [tenantId],
    );
    _policyCache = rows;
    _policyCacheAt = Date.now();
    return _policyCache;
  } catch {
    return _policyCache ?? [];
  }
}

function isPlannerVisibleTool(
  def: ToolDefinition,
  hiddenRules: ToolPolicyRule[],
): boolean {
  for (const rule of hiddenRules) {
    if (rule.rule_type !== "hidden") continue;
    switch (rule.match_field) {
      case "prefix":
        if (def.name.startsWith(rule.match_pattern)) return false;
        break;
      case "tag":
        if (def.tags.some(t => String(t).toLowerCase() === rule.match_pattern.toLowerCase())) return false;
        break;
      case "name":
        if (def.name === rule.match_pattern) return false;
        break;
    }
  }
  return true;
}

// ─── 公开 API ─────────────────────────────────────────────────────

/** 清除工具目录查询缓存（工具配置变更时可调用，TTL 过期后也会自动失效） */
export function invalidateToolCatalogQueryCache(tenantId?: string): void {
  if (!tenantId) {
    _toolDiscoveryCache.clear();
    return;
  }
  for (const [key] of _toolDiscoveryCache) {
    if (key.startsWith(tenantId + ":")) _toolDiscoveryCache.delete(key);
  }
}

export async function discoverEnabledTools(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  locale: string;
  /** P2: 可选-按分类过滤 */
  category?: string;
  /** P2: 可选-返回数量限制（默认不限） */
  limit?: number;
  /** P2: 可选-搜索关键词（用于标签匹配） */
  query?: string;
  /** P1-2: 跳过缓存（强制刷新） */
  skipCache?: boolean;
  /** 包含默认不暴露给规划层的内部/原语工具 */
  includeHiddenTools?: boolean;
}): Promise<{ catalog: string; tools: EnabledTool[] }> {
  try {
    // P1-2 FIX: 优先从缓存读取
    const cacheKey = _toolDiscoveryCacheKey(params.tenantId, params.spaceId, params.locale, params.category, params.query, params.includeHiddenTools);
    if (!params.skipCache) {
      const cached = _toolDiscoveryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
    }
    const defs = await listToolDefinitions(params.pool, params.tenantId);
    if (!defs.length) return { catalog: "", tools: [] };

    // 从 DB 加载 tool_policy_rules
    const policyRules = await loadToolPolicyRules(params.pool, params.tenantId);
    const hiddenRules = policyRules.filter(r => r.rule_type === "hidden");

    // P2: 按分类过滤
    let filteredDefs = params.includeHiddenTools ? defs : defs.filter(d => isPlannerVisibleTool(d, hiddenRules));
    if (params.category) {
      filteredDefs = filteredDefs.filter(d => d.category === params.category);
    }

    // P2: 按标签搜索
    if (params.query) {
      const queryLower = params.query.toLowerCase();
      filteredDefs = filteredDefs.filter(d => {
        // 匹配标签
        if (d.tags.some(tag => tag.toLowerCase().includes(queryLower))) return true;
        // 匹配名称
        if (d.name.toLowerCase().includes(queryLower)) return true;
        // 匹配描述
        const desc = i18nText(d.description, params.locale).toLowerCase();
        if (desc.includes(queryLower)) return true;
        return false;
      });
    }

    // P2: 按优先级排序（高优先级在前），其次按名称
    const sortedDefs = [...filteredDefs].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.name.localeCompare(b.name);
    });

    // 从 DB 规则构建 pinned 顺序
    const pinnedRules = policyRules
      .filter(r => r.rule_type === "pinned")
      .sort((a, b) => (a.effect.pinnedOrder ?? 99) - (b.effect.pinnedOrder ?? 99));
    const pinnedNames = pinnedRules.map(r => r.match_pattern);
    // 元数据驱动：pinned 顺序完全来自 DB tool_policy_rules 规则
    const effectivePinnedNames = pinnedNames;

    const pinned: ToolDefinition[] = [];
    for (const n of effectivePinnedNames) {
      const d = sortedDefs.find(x => x.name === n);
      if (d) pinned.push(d);
    }
    const pinnedNameSet = new Set(effectivePinnedNames);
    const orderedDefs = [...pinned, ...sortedDefs.filter(d => !pinnedNameSet.has(d.name))];

    const toolResults = await Promise.all(orderedDefs.map(async (def): Promise<EnabledTool | null> => {
      try {
        let effRef = await resolveEffectiveToolRef({
          pool: params.pool,
          tenantId: params.tenantId,
          spaceId: params.spaceId,
          name: def.name,
        });
        if (!effRef) return null;
        let enabled = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: effRef });
        if (!enabled) {
          const latest = await getLatestReleasedToolVersion(params.pool, params.tenantId, def.name);
          const latestRef = latest?.toolRef ?? null;
          if (latestRef && latestRef !== effRef) {
            const enabled2 = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: latestRef });
            if (enabled2) {
              effRef = latestRef;
              enabled = true;
            }
          }
        }
        if (!enabled) return null;
        const ver = await getToolVersionByRef(params.pool, params.tenantId, effRef);
        if (!ver || ver.status !== "released") return null;
        return { name: def.name, toolRef: effRef, def, ver };
      } catch {
        return null;
      }
    }));
    const enabledTools: EnabledTool[] = toolResults.filter((t): t is EnabledTool => t !== null);
    if (!enabledTools.length) {
      // P1-2: 空结果也缓存（避免反复查 DB），但 TTL 更短
      const emptyResult = { catalog: "", tools: [] as EnabledTool[] };
      _toolDiscoveryCache.set(cacheKey, { result: emptyResult, expiresAt: Date.now() + Math.min(TOOL_DISCOVERY_CACHE_TTL_MS, 15_000) });
      return emptyResult;
    }

    let totalChars = 0;
    const lines: string[] = [];
    const effectiveLimit = params.limit ?? Infinity;
    let toolCount = 0;
    
    for (const t of enabledTools) {
      // P2: 应用数量限制
      if (toolCount >= effectiveLimit) break;
      
      const displayName = i18nText(t.def.displayName, params.locale) || t.name;
      const desc = i18nText(t.def.description, params.locale);
      const inputFields = t.ver?.inputSchema?.fields
        ? Object.entries(t.ver.inputSchema.fields as Record<string, any>)
            .map(([k, v]) => {
              const type = v?.type ?? "string";
              const req = v?.required ? "*" : "";
              const descRaw = typeof v?.description === "string" ? v.description : "";
              const descShort = descRaw.length > 120 ? descRaw.slice(0, 120) + "..." : descRaw;
              return `${k}:${type}${req}${descShort ? "(" + descShort + ")" : ""}`;
            })
            .join(", ")
        : "";
      const line = `- ${t.toolRef} | ${displayName}${desc ? ": " + desc : ""}${inputFields ? " | input: {" + inputFields + "}" : ""} | risk=${t.def.riskLevel} | priority=${t.def.priority}${t.def.category !== 'uncategorized' ? ' | category=' + t.def.category : ''}`;
      if (totalChars + line.length > TOOLS_CATALOG_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
      toolCount++;
    }
    const result = { catalog: lines.join("\n"), tools: enabledTools };

    // P1-2 FIX: 写入缓存，超出最大条目数时清理最旧的
    if (_toolDiscoveryCache.size >= TOOL_DISCOVERY_CACHE_MAX_ENTRIES) {
      const firstKey = _toolDiscoveryCache.keys().next().value;
      if (firstKey !== undefined) _toolDiscoveryCache.delete(firstKey);
    }
    _toolDiscoveryCache.set(cacheKey, { result, expiresAt: Date.now() + TOOL_DISCOVERY_CACHE_TTL_MS });

    return result;
  } catch (err) {
    _logger.warn("discoverEnabledTools failed", { err: (err as Error)?.message });
    return { catalog: "", tools: [] };
  }
}
