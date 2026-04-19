/**
 * intentAnchorRules.ts — 意图锚定规则加载
 *
 * 从 JSON 配置文件 / 环境变量路径加载禁令/约束匹配模式，
 * 回退到内置默认规则。
 *
 * @module intentAnchorRules
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StructuredLogger } from "@openslin/shared";

const logger = new StructuredLogger({ module: "intentAnchoring.rules" });

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AnchorPatternRule {
  re: RegExp;
  type: "prohibition" | "constraint" | "preference";
  priority: number;
}

interface AnchorRulesJson {
  prohibitionPatterns?: Array<{ re: string; priority?: number }>;
  constraintPatterns?: Array<{ re: string; priority?: number }>;
}

/* ------------------------------------------------------------------ */
/*  Built-in defaults                                                  */
/* ------------------------------------------------------------------ */

/** 内置默认禁令规则（配置文件不存在时回退）
 * 注意：正则不带 /g 标志，使用时按需添加以避免 lastIndex 状态残留 */
export const BUILTIN_PROHIBITION_PATTERNS: AnchorPatternRule[] = [
  { re: /(?:不要|禁止|避免|切勿)\s*([^，。！？,!?\n]+)/, type: "prohibition", priority: 10 },
  { re: /(?:don't|do not|avoid|never)\s+([^,.\n!?]+)/i, type: "prohibition", priority: 10 },
];

export const BUILTIN_CONSTRAINT_PATTERNS: AnchorPatternRule[] = [
  { re: /(?:必须|一定要|务必|需要)\s*([^，。！？,!?\n]+)/, type: "constraint", priority: 20 },
  { re: /(?:must|have to|need to|should)\s+([^,.\n!?]+)/i, type: "constraint", priority: 20 },
];

/* ------------------------------------------------------------------ */
/*  Loader                                                             */
/* ------------------------------------------------------------------ */

export function loadAnchorRules(): {
  prohibition: AnchorPatternRule[];
  constraint: AnchorPatternRule[];
} {
  try {
    const cfgPath =
      process.env.INTENT_ANCHOR_RULES_PATH ||
      path.resolve(__dirname, "anchor-rules.json");
    if (fs.existsSync(cfgPath)) {
      const json: AnchorRulesJson = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const prohibition = (json.prohibitionPatterns ?? []).map((p) => ({
        re: new RegExp(p.re),
        type: "prohibition" as const,
        priority: p.priority ?? 10,
      }));
      const constraint = (json.constraintPatterns ?? []).map((p) => ({
        re: new RegExp(p.re),
        type: "constraint" as const,
        priority: p.priority ?? 20,
      }));
      return {
        prohibition: prohibition.length > 0 ? prohibition : BUILTIN_PROHIBITION_PATTERNS,
        constraint: constraint.length > 0 ? constraint : BUILTIN_CONSTRAINT_PATTERNS,
      };
    }
  } catch (err) {
    logger.warn(`Failed to load anchor rules: ${(err as Error)?.message}`);
  }
  return {
    prohibition: BUILTIN_PROHIBITION_PATTERNS,
    constraint: BUILTIN_CONSTRAINT_PATTERNS,
  };
}

/** 模块级单例 */
const _anchorRules = loadAnchorRules();

/** 获取当前已加载的锚定规则 */
export function getAnchorRules() {
  return _anchorRules;
}
