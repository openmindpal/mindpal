/**
 * Schema-UI Generator — 核心生成逻辑
 *
 * 三层快速路径：启发式规则 → DB缓存 → LLM生成
 * 保留：置信度阈值、字段级安全(T12)、LLM熔断调用
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SchemaUiConfig, SchemaUiHints } from "@openslin/shared";
import { invokeModelChat } from "../../../lib/llm";
import { listLatestReleased } from "../../../modules/metadata/schemaRepo";

/* ── 置信度阈值 ── */
const CONFIDENCE_THRESHOLD = 0.4;
const CACHE_TTL_DAYS = 7;

/* ── 启发式规则（数据驱动 15 条） ── */
const HEURISTIC_RULES: Array<{
  patterns: RegExp[];
  layout: SchemaUiHints['layout'];
  confidence: number;
  needsEntity?: boolean;
}> = [
  // 1. 表格/列表
  { patterns: [/(?:显示|查看|列出|展示).*(?:列表|记录|数据)/, /(?:show|list|display).*(?:list|records|data)/i], layout: 'table', confidence: 0.85, needsEntity: true },
  // 2. 卡片概览
  { patterns: [/(?:卡片|概览)/, /(?:cards|overview)/i], layout: 'cards', confidence: 0.80, needsEntity: true },
  // 3. 表单
  { patterns: [/(?:新建|创建|添加|录入|编辑)/, /(?:create|new|add|edit)/i], layout: 'form', confidence: 0.80, needsEntity: true },
  // 4. 看板
  { patterns: [/(?:看板|分栏|泳道)/, /(?:kanban|swimlane|board)/i], layout: 'kanban', confidence: 0.80, needsEntity: true },
  // 5. 时间线
  { patterns: [/(?:时间线|时间轴|历史|变更记录)/, /(?:timeline|history|changelog)/i], layout: 'timeline', confidence: 0.78, needsEntity: true },
  // 6. 统计
  { patterns: [/(?:统计|汇总|指标|KPI|总览)/, /(?:stats|summary|KPI|metrics)/i], layout: 'stats', confidence: 0.80, needsEntity: true },
  // 7. 树形
  { patterns: [/(?:树形|层级|组织|目录)/, /(?:tree|hierarchy|org)/i], layout: 'tree', confidence: 0.78, needsEntity: true },
  // 8. 图表
  { patterns: [/(?:图表|柱状图|折线图|饼图)/, /(?:chart|bar\s*chart|line\s*chart|pie\s*chart)/i], layout: 'chart', confidence: 0.82, needsEntity: true },
  // 9. 仪表盘
  { patterns: [/(?:仪表盘|大屏|监控)/, /(?:dashboard|monitor)/i], layout: 'dashboard', confidence: 0.80, needsEntity: true },
  // 10. 文档
  { patterns: [/(?:文档|说明|帮助|介绍)/, /(?:document|help|intro|guide)/i], layout: 'markdown', confidence: 0.75, needsEntity: false },
  // 11. 报表
  { patterns: [/(?:报表|报告|分析)/, /(?:report|analysis)/i], layout: 'table', confidence: 0.78, needsEntity: true },
  // 12. 日历
  { patterns: [/(?:日历|日程|排期)/, /(?:calendar|schedule)/i], layout: 'timeline', confidence: 0.75, needsEntity: true },
  // 13. 对比
  { patterns: [/(?:对比|比较)/, /(?:compare|versus)/i], layout: 'table', confidence: 0.75, needsEntity: true },
  // 14. 流程
  { patterns: [/(?:流程|步骤|进度)/, /(?:process|steps|progress)/i], layout: 'timeline', confidence: 0.75, needsEntity: true },
  // 15. 搜索
  { patterns: [/(?:搜索|查找|筛选)/, /(?:search|find|filter)/i], layout: 'table', confidence: 0.78, needsEntity: true },
];

type HeuristicResult = { layout: SchemaUiHints["layout"]; entity: string; confidence: number };

function tryHeuristic(input: string, entityNames: string[]): HeuristicResult | null {
  const normalized = input.toLowerCase().trim();
  for (const rule of HEURISTIC_RULES) {
    const matched = rule.patterns.some(p => p.test(normalized));
    if (!matched) continue;
    if (rule.needsEntity !== false) {
      const entity = entityNames.find(e => normalized.includes(e.toLowerCase()));
      if (entity) return { layout: rule.layout, entity, confidence: rule.confidence };
    } else {
      return { layout: rule.layout, entity: '', confidence: rule.confidence };
    }
  }
  return null;
}

/* ── 缓存层 ── */
function inputHash(input: string): string {
  return crypto.createHash("sha256").update(input.trim().toLowerCase()).digest("hex");
}

async function getFromCache(pool: any, tenantId: string, hash: string): Promise<SchemaUiConfig | null> {
  try {
    const res = await pool.query(
      "SELECT generated_config FROM schema_ui_generation_cache WHERE tenant_id = $1 AND user_input_hash = $2 AND expires_at > NOW() LIMIT 1",
      [tenantId, hash],
    );
    if (res.rowCount && res.rows[0]?.generated_config) {
      return res.rows[0].generated_config as SchemaUiConfig;
    }
  } catch { /* 缓存失败静默降级 */ }
  return null;
}

async function writeCache(pool: any, tenantId: string, userId: string, hash: string, config: SchemaUiConfig) {
  try {
    const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 86400000).toISOString();
    await pool.query(
      `INSERT INTO schema_ui_generation_cache (tenant_id, user_id, user_input_hash, generated_config, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id, user_input_hash) DO UPDATE SET generated_config = $4, updated_at = NOW(), expires_at = $5`,
      [tenantId, userId, hash, JSON.stringify(config), expiresAt],
    );
  } catch { /* 写缓存失败不阻塞 */ }
}

/* ── 实体发现 ── */
async function discoverEntities(pool: any): Promise<string[]> {
  const schemas = await listLatestReleased(pool);
  const names: string[] = [];
  for (const s of schemas) {
    const entities = (s as any).schema?.entities;
    if (entities && typeof entities === "object") {
      names.push(...Object.keys(entities));
    }
  }
  return [...new Set(names)];
}

/* ── System Prompt ── */
function buildSystemPrompt(entityNames: string[]): string {
  return `你是一个 Schema-UI 生成助手。根据用户输入生成 JSON 配置。

可用实体: ${entityNames.length > 0 ? entityNames.join(", ") : "（暂无实体）"}

严格输出以下 JSON（不要输出其他内容）:
{
  "intent": "ui" 或 "chat",
  "confidence": 0-1 的置信度,
  "schema": JSON Schema (draft-7) 描述数据结构,
  "uiHints": {
    "layout": "table" | "cards" | "form" | "chart" | "markdown" | "dashboard" | "kanban" | "timeline" | "stats" | "tree",
    "title": "页面标题",
    "description": "页面描述",
    "columns": ["字段1", "字段2"],
    "groupBy": "分组字段（cards时）",
    "chartType": "bar" | "line" | "pie"（chart时）,
    "timeField": "时间字段名（timeline时）",
    "columnField": "分栏字段名（kanban时）",
    "statFields": ["统计字段1", "统计字段2"]（stats时）,
    "parentField": "父节点字段名（tree时）",
    "fieldDeps": { "源字段": "目标字段" }（form字段联动时）,
    "style": {}
  },
  "mdx": "可选MDX富文本",
  "dataBindings": [{ "entity": "实体名", "mode": "list" | "query", "filter": {}, "sort": {}, "limit": 50 }],
  "metadata": {}
}

示例1: 用户输入 "显示客户列表"
{"intent":"ui","confidence":0.9,"uiHints":{"layout":"table","title":"客户列表"},"dataBindings":[{"entity":"customers","mode":"list"}]}

示例2: 用户输入 "订单统计"
{"intent":"ui","confidence":0.85,"uiHints":{"layout":"stats","title":"订单统计","statFields":["total","count"]},"dataBindings":[{"entity":"orders","mode":"query"}]}

规则:
- 如果用户输入是闲聊、问候或与数据无关的问题，返回 intent:"chat", confidence:0.2
- 如果无法确定用户想要什么布局，优先使用 table
- statFields 仅在 layout 为 stats 时需要
- timeField 仅在 layout 为 timeline 时需要
- columnField 仅在 layout 为 kanban 时需要
- parentField 仅在 layout 为 tree 时需要
- fieldDeps 仅在 layout 为 form 且有字段联动需求时使用
- 优先匹配已有实体名
- schema 中的 properties 应包含实际字段定义
- layout 根据用户意图选择最合适的类型`;
}

/* ── 主入口 ── */
export async function generateSchemaUi(opts: {
  userInput: string;
  tenantId: string;
  userId?: string;
  modelRef?: string;
  app: FastifyInstance;
}): Promise<SchemaUiConfig | null> {
  const { userInput, tenantId, userId = "anonymous", app } = opts;
  const pool = (app as any).db;

  // 1. 实体发现
  const entityNames = await discoverEntities(pool);

  // 2. 启发式快速路径
  const heuristic = tryHeuristic(userInput, entityNames);
  if (heuristic && heuristic.confidence >= CONFIDENCE_THRESHOLD) {
    const config: SchemaUiConfig = {
      intent: "ui",
      confidence: heuristic.confidence,
      schema: {
        type: "object",
        properties: {},
        title: heuristic.entity ?? "data",
      },
      uiHints: {
        layout: heuristic.layout,
        title: heuristic.entity ? `${heuristic.entity} ${heuristic.layout}` : userInput,
      },
      dataBindings: heuristic.entity
        ? [{ entity: heuristic.entity, mode: "list" as const }]
        : [],
    };
    // 异步写缓存
    writeCache(pool, tenantId, userId, inputHash(userInput), config).catch(() => {});
    return config;
  }

  // 3. DB缓存
  const hash = inputHash(userInput);
  const cached = await getFromCache(pool, tenantId, hash);
  if (cached) return cached;

  // 4. LLM 生成
  const systemPrompt = buildSystemPrompt(entityNames);
  const result = await invokeModelChat({
    app,
    subject: { tenantId, subjectId: userId },
    locale: "zh-CN",
    purpose: "schema-ui.generate",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ],
    ...(opts.modelRef ? { constraints: { candidates: [opts.modelRef] } } : {}),
  });

  // 解析 LLM 输出
  const outputText = typeof result.outputText === "string" ? result.outputText : "";
  let config: SchemaUiConfig;
  try {
    // 尝试从输出中提取 JSON
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    config = JSON.parse(jsonMatch[0]) as SchemaUiConfig;
  } catch {
    return null;
  }

  // 置信度阈值检查
  if (typeof config.confidence !== "number" || config.confidence < CONFIDENCE_THRESHOLD) {
    return null;
  }

  // T12: 字段级安全 — 从 schema 中移除不在 entityNames 中的绑定实体
  if (Array.isArray(config.dataBindings)) {
    config.dataBindings = config.dataBindings.filter(
      (b) => entityNames.includes(b.entity),
    );
  }

  // 异步写缓存
  writeCache(pool, tenantId, userId, hash, config).catch(() => {});
  return config;
}
