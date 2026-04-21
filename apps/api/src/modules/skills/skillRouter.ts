/**
 * Skill Intent Router
 *
 * 中立的语义路由模块：
 * - 供 kernel 在规划阶段做技能/工具优先级提示
 * - 供 skill-manager 在创建前做重复检测
 */
import type { Pool } from "pg";
import {
  findSimilarSkills,
  detectDuplicateSkill,
  type SimilarSkill,
} from "./skillSemanticRepo";

export interface RouteResult {
  resolved: boolean;
  bestMatch: SimilarSkill | null;
  confidence: number;
  ambiguous: boolean;
  candidates: SimilarSkill[];
  suggestion: RouteSuggestion;
}

export type RouteSuggestion =
  | { type: "use"; skillName: string; reason: string }
  | { type: "choose"; options: Array<{ skillName: string; description: string }> }
  | { type: "create"; reason: string }
  | { type: "none"; reason: string };

export interface DuplicateCheckResult {
  shouldCreate: boolean;
  similar: SimilarSkill[];
  recommendation: "create" | "reuse" | "differentiate";
  message: Record<string, string>;
}

const THRESHOLD = {
  HIGH_CONFIDENCE: 0.85,
  MEDIUM_CONFIDENCE: 0.65,
  LOW_CONFIDENCE: 0.4,
  AMBIGUITY_GAP: 0.15,
  DUPLICATE: 0.75,
};

export async function routeByIntent(params: {
  pool: Pool;
  tenantId: string;
  intent: string;
}): Promise<RouteResult> {
  const { pool, tenantId, intent } = params;
  const similar = await findSimilarSkills({
    pool,
    tenantId,
    query: intent,
    limit: 10,
    minSimilarity: THRESHOLD.LOW_CONFIDENCE,
    onlyEnabled: true,
  });

  if (similar.length === 0) {
    return {
      resolved: false,
      bestMatch: null,
      confidence: 0,
      ambiguous: false,
      candidates: [],
      suggestion: { type: "none", reason: "未找到匹配的技能" },
    };
  }

  const best = similar[0]!;
  const second = similar[1];

  if (best.similarity >= THRESHOLD.HIGH_CONFIDENCE) {
    return {
      resolved: true,
      bestMatch: best,
      confidence: best.similarity,
      ambiguous: false,
      candidates: similar,
      suggestion: {
        type: "use",
        skillName: best.skillName,
        reason: `高度匹配（${Math.round(best.similarity * 100)}%）`,
      },
    };
  }

  const hasAmbiguity =
    second &&
    best.similarity >= THRESHOLD.MEDIUM_CONFIDENCE &&
    best.similarity - second.similarity < THRESHOLD.AMBIGUITY_GAP;

  if (hasAmbiguity) {
    const ambiguousCandidates = similar.filter(
      (s) => best.similarity - s.similarity < THRESHOLD.AMBIGUITY_GAP
    );

    return {
      resolved: false,
      bestMatch: best,
      confidence: best.similarity,
      ambiguous: true,
      candidates: ambiguousCandidates,
      suggestion: {
        type: "choose",
        options: ambiguousCandidates.map((s) => ({
          skillName: s.skillName,
          description: getDescriptionText(s.description) || s.skillName,
        })),
      },
    };
  }

  if (best.similarity >= THRESHOLD.MEDIUM_CONFIDENCE) {
    return {
      resolved: true,
      bestMatch: best,
      confidence: best.similarity,
      ambiguous: false,
      candidates: similar,
      suggestion: {
        type: "use",
        skillName: best.skillName,
        reason: `最佳匹配（${Math.round(best.similarity * 100)}%）`,
      },
    };
  }

  return {
    resolved: false,
    bestMatch: best,
    confidence: best.similarity,
    ambiguous: false,
    candidates: similar,
    suggestion: {
      type: "none",
      reason: `未找到高度匹配的技能，最相似的是 ${best.skillName}（${Math.round(best.similarity * 100)}%）`,
    },
  };
}

export async function checkBeforeCreate(params: {
  pool: Pool;
  tenantId: string;
  skillName: string;
  description: string;
}): Promise<DuplicateCheckResult> {
  const { pool, tenantId, skillName, description } = params;
  const result = await detectDuplicateSkill({
    pool,
    tenantId,
    skillName,
    description,
    threshold: THRESHOLD.DUPLICATE,
  });

  let message: Record<string, string>;
  switch (result.recommendation) {
    case "reuse": {
      const top = result.similar[0];
      message = {
        "zh-CN": `检测到高度相似的技能：${top?.skillName}（相似度${Math.round((top?.similarity ?? 0) * 100)}%）。建议直接使用已有技能，或修改后再创建。`,
        "en-US": `Found highly similar skill: ${top?.skillName} (${Math.round((top?.similarity ?? 0) * 100)}% similar). Recommend using existing skill or modify before creating.`,
      };
      break;
    }
    case "differentiate":
      message = {
        "zh-CN": `检测到${result.similar.length}个相似技能。如确需创建，请确保功能有明显差异。`,
        "en-US": `Found ${result.similar.length} similar skills. If you must create, please ensure distinct functionality.`,
      };
      break;
    default:
      message = {
        "zh-CN": "未检测到重复技能，可以创建。",
        "en-US": "No duplicate detected, you can create.",
      };
  }

  return {
    shouldCreate: result.recommendation === "create",
    similar: result.similar,
    recommendation: result.recommendation,
    message,
  };
}

export function formatAmbiguityPrompt(candidates: SimilarSkill[], locale: string = "zh-CN"): string {
  const isZh = locale.startsWith("zh");

  if (isZh) {
    const lines = ["找到多个相似技能，请选择："];
    candidates.forEach((c, i) => {
      const desc = getDescriptionText(c.description, "zh-CN") || c.skillName;
      lines.push(`${i + 1}. ${c.skillName} - ${desc}（相似度${Math.round(c.similarity * 100)}%）`);
    });
    return lines.join("\n");
  }

  const lines = ["Found multiple similar skills, please choose:"];
  candidates.forEach((c, i) => {
    const desc = getDescriptionText(c.description, "en-US") || c.skillName;
    lines.push(`${i + 1}. ${c.skillName} - ${desc} (${Math.round(c.similarity * 100)}% similar)`);
  });
  return lines.join("\n");
}

export function formatDuplicatePrompt(result: DuplicateCheckResult, locale: string = "zh-CN"): string {
  const isZh = locale.startsWith("zh");
  const msg = result.message[locale] ?? result.message["zh-CN"] ?? result.message["en-US"] ?? "";
  if (result.similar.length === 0) return msg;

  const lines = [msg, "", isZh ? "相似技能：" : "Similar skills:"];
  result.similar.slice(0, 5).forEach((s, i) => {
    const desc = getDescriptionText(s.description, locale) || s.skillName;
    lines.push(`${i + 1}. ${s.skillName} - ${desc} (${Math.round(s.similarity * 100)}%)`);
  });
  return lines.join("\n");
}

function getDescriptionText(
  description: Record<string, string> | string | null | undefined,
  locale: string = "zh-CN",
): string {
  if (!description) return "";
  if (typeof description === "string") return description;
  return description[locale] ?? description["zh-CN"] ?? description["en-US"] ?? "";
}
