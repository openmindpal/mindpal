/**
 * memoryCore — 记忆系统共享纯函数与类型定义
 *
 * 此模块是记忆系统的唯一权威工具库：
 * - 语义向量（minhash:16@1）计算
 * - 记忆类型风险分级模型
 * - WriteProof / WriteIntent 类型定义
 *
 * apps/api/src/modules/memory/repo.ts 和 apps/worker/src/memory/processor.ts
 * 都必须从此处导入，禁止各自重复实现。
 */
import crypto from "node:crypto";

/* ══════════════════════════════════════════════════════════════════
 * 1. Minhash 语义向量工具（minhash:16@1 标准）
 * ══════════════════════════════════════════════════════════════════ */

export const MINHASH_K = 16;
export const MINHASH_MODEL_REF = "minhash:16@1";

/** 简易分词器：CJK 单字 + Latin 连续子串，最多 512 个 token */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    // CJK 统一表意文字区间：每个汉字作为独立 token
    if (code >= 0x4e00 && code <= 0x9fff) {
      if (buf.length >= 2) out.push(buf);
      buf = "";
      out.push(ch);
      if (out.length >= 512) break;
      continue;
    }
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
    if (ok) buf += ch;
    else {
      if (buf.length >= 2) out.push(buf);
      buf = "";
    }
    if (out.length >= 512) break;
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

/** 取 SHA-256 前 4 字节作为 int32 */
export function hash32(str: string): number {
  const h = crypto.createHash("sha256").update(str, "utf8").digest();
  return h.readInt32BE(0);
}

/** 计算 k 维 minhash 向量 */
export function computeMinhash(text: string, k: number = MINHASH_K): number[] {
  const toks = tokenize(text);
  const mins = new Array<number>(k).fill(2147483647);
  for (const t of toks) {
    for (let i = 0; i < k; i++) {
      const v = hash32(`${i}:${t}`);
      if (v < mins[i]!) mins[i] = v;
    }
  }
  return mins.map((x) => (x === 2147483647 ? 0 : x));
}

/** 计算两个 minhash 向量的 overlap 得分（0~1） */
export function minhashOverlapScore(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const v of a) if (setB.has(v)) hit++;
  return hit / a.length;
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 记忆类型风险分级模型
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 记忆类型风险等级映射
 * - low: 用户偏好、设置、备忘
 * - medium: 事实、身份、个人信息
 * - high: 关系、凭证、敏感信息
 */
export const MEMORY_TYPE_RISK_LEVELS: Record<string, "low" | "medium" | "high"> = {
  // 低风险
  preference: "low", setting: "low", note: "low", reminder: "low",
  // 中风险
  fact: "medium", identity: "medium", profile: "medium", user_profile: "medium", contact: "medium", address: "medium", interest: "medium",
  // 高风险
  relationship: "high", credential: "high", secret: "high", financial: "high", medical: "high", biometric: "high",
};

/** 默认风险等级（未知类型按 medium 处理） */
export const DEFAULT_RISK_LEVEL: "low" | "medium" | "high" = "medium";

/** 需要强制审批的风险等级 */
export const APPROVAL_REQUIRED_RISK_LEVELS: ReadonlySet<"low" | "medium" | "high"> = new Set(["high"]);

/** 内容敏感模式定义 */
const CONTENT_SENSITIVE_PATTERNS = [
  { pattern: /\b(password|密码|pwd)\b/i, risk: "high" as const, factor: "content:password" },
  { pattern: /\b(身份证|idcard|id\s*card)\b/i, risk: "high" as const, factor: "content:idcard" },
  { pattern: /\b(银行卡|bank\s*card|credit\s*card)\b/i, risk: "high" as const, factor: "content:bankcard" },
  { pattern: /\b(手机号?|phone|mobile)[:：]?\s*\d{11}/i, risk: "medium" as const, factor: "content:phone" },
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i, risk: "medium" as const, factor: "content:email" },
] as const;

/** 风险评估结果 */
export type MemoryRiskEvaluation = {
  riskLevel: "low" | "medium" | "high";
  approvalRequired: boolean;
  riskFactors: string[];
};

/**
 * 评估记忆写入的风险等级
 * 综合 type 风险 + 内容启发式检测
 */
export function evaluateMemoryRisk(params: {
  type: string;
  contentText?: string;
  title?: string | null;
}): MemoryRiskEvaluation {
  const riskFactors: string[] = [];
  let riskLevel = MEMORY_TYPE_RISK_LEVELS[params.type.toLowerCase()] ?? DEFAULT_RISK_LEVEL;

  // 类型风险
  if (MEMORY_TYPE_RISK_LEVELS[params.type.toLowerCase()]) {
    riskFactors.push(`type:${params.type}`);
  } else {
    riskFactors.push(`type:unknown(${params.type})`);
  }

  // 内容启发式检测
  if (params.contentText) {
    const content = params.contentText.toLowerCase();
    for (const { pattern, risk, factor } of CONTENT_SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        riskFactors.push(factor);
        // 只升不降
        if (risk === "high" && riskLevel !== "high") riskLevel = "high";
        else if (risk === "medium" && riskLevel === "low") riskLevel = "medium";
      }
    }
  }

  // 仅类型风险（medium）+ 无敏感内容命中 + 短文本 → 降级为 low
  // 通用规则：用户主动提供的短文本信息，不含敏感模式，无需强制确认
  if (riskLevel === "medium" && riskFactors.length === 1 && riskFactors[0].startsWith("type:") && (params.contentText?.length ?? 0) <= 50) {
    riskLevel = "low";
  }

  return { riskLevel, approvalRequired: APPROVAL_REQUIRED_RISK_LEVELS.has(riskLevel), riskFactors };
}

/* ══════════════════════════════════════════════════════════════════
 * 3. WriteProof / WriteIntent 类型定义
 * ══════════════════════════════════════════════════════════════════ */

/**
 * WriteProof: 服务端生成的写入证明结构
 * - 客户端不可直接写入，必须由服务端根据校验结果生成
 */
export type WriteProof = {
  /** 写入策略类型 */
  policy: "confirmed" | "approved" | "policyAllowed";
  /** 证明生成时间 (ISO 8601) */
  provenAt: string;
  /** 证明生成者标识：'system' 或 subjectId */
  provenBy: string;
  /** 审批 ID（仅 approved 策略时存在） */
  approvalId?: string;
  /** 审批决策者 subjectId（仅 approved 策略时存在） */
  approvedBySubjectId?: string;
  /** 用户确认引用（仅 confirmed 策略时存在） */
  confirmationRef?: {
    requestId: string;
    turnId?: string;
    confirmationType: "explicit" | "implicit";
  };
  /** 策略决策引用（仅 policyAllowed 策略时存在） */
  policyRef?: {
    snapshotRef?: string;
    decision: "allow";
  };
};

/**
 * WriteIntent: 客户端提交的写入意图
 * - 客户端声明期望的写入策略，由服务端校验并生成 WriteProof
 */
export type WriteIntent = {
  /** 期望的写入策略 */
  policy: "confirmed" | "approved" | "policyAllowed";
  /** 审批 ID（approved 策略时必须提供） */
  approvalId?: string;
  /** 确认引用（confirmed 策略时必须提供） */
  confirmationRef?: {
    requestId: string;
    turnId?: string;
    confirmationType: "explicit" | "implicit";
  };
  /** 策略决策引用（policyAllowed 策略时可选提供） */
  policyRef?: {
    snapshotRef?: string;
  };
};

/* ══════════════════════════════════════════════════════════════════
 * 4. SHA-256 摘要
 * ══════════════════════════════════════════════════════════════════ */

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/* ══════════════════════════════════════════════════════════════════
 * 4b. Cosine Similarity（向量工具函数）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 计算两个向量的 cosine 相似度（0~1）。
 * API / Worker 共享权威实现，消除各端私有副本。
 * 未来迁移 pgvector 后，此函数作为回退路径保留。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 统一 Rerank 评分函数（API / Worker 共享权威实现）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 记忆 Rerank 候选项输入（从 DB 行映射而来）
 */
export interface MemoryRerankInput {
  contentText: string;
  title: string | null;
  createdAt: string;
  embeddingMinhash: number[];
  /** dense vector cosine（无则传 0） */
  denseScore: number;
  /** 召回通道标记："lexical" | "vector" | "both" | "dense_vector" */
  stage: string;
  confidence: number;
  factVersion: number;
  conflictMarker: string | null;
  resolutionStatus: string | null;
  memoryClass: string;
  decayScore: number;
  distilledTo: string | null;
  /** source_ref.priority（0-100, 默认 0） */
  sourcePriority: number;
}

/** 记忆分类加权因子 */
const MEMORY_CLASS_WEIGHT: Record<string, number> = {
  procedural: 0.20,
  semantic: 0.10,
  episodic: 0.0,
};

/**
 * 计算单条记忆候选的 Rerank 得分（12 因子统一公式）。
 *
 * 因子清单：
 *  1. sLex × 1.2       词法匹配
 *  2. sVec             Minhash overlap
 *  3. sDense × 1.5     Dense cosine
 *  4. recency × 0.05   时间新鲜度
 *  5. bothBonus 0.1    多通道命中
 *  6. confidence       置信度 × 30d半衰期 × 0.15
 *  7. versionBoost     factVersion / 10, max 0.1
 *  8. conflictPenalty  未解决冲突 -0.2
 *  9. classBoost       procedural=0.2, semantic=0.1
 * 10. decayBoost       (decayScore - 0.5) × 0.2
 * 11. distilledPenalty 已蒸馏源 -0.15
 * 12. priorityBoost    (priority/100) × 0.08
 */
export function computeMemoryRerankScore(
  c: MemoryRerankInput,
  query: string,
  queryMinhash: number[],
  nowMs: number,
): number {
  const queryLower = query.toLowerCase();
  const text = (c.contentText ?? "").toLowerCase();
  const title = (c.title ?? "").toLowerCase();

  // 1. Lexical match
  const sLex = (text.includes(queryLower) || title.includes(queryLower)) ? 1 : 0;
  // 2. Minhash overlap
  const sVec = minhashOverlapScore(queryMinhash, c.embeddingMinhash);
  // 3. Dense cosine
  const sDense = Number.isFinite(c.denseScore) ? c.denseScore : 0;
  // 4. Recency
  const createdAtMs = Date.parse(c.createdAt ?? "");
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : 0;
  const recencyBoost = 1 / (1 + ageMs / (24 * 60 * 60 * 1000));
  // 5. Both-stage bonus
  const bothBonus = c.stage === "both" ? 0.1 : 0;
  // 6. Confidence × 30d 半衰期衰减
  const dbConf = Number.isFinite(c.confidence) ? Math.max(0, Math.min(1, c.confidence)) : 0.5;
  const confDecay = Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000));
  const confidenceBoost = dbConf * confDecay * 0.15;
  // 7. factVersion
  const fv = Number.isFinite(c.factVersion) ? c.factVersion : 1;
  const versionBoost = Math.min(fv / 10, 0.1);
  // 8. Conflict penalty
  const hasConflict = c.conflictMarker && c.resolutionStatus !== "resolved" && c.resolutionStatus !== "superseded";
  const conflictPenalty = hasConflict ? -0.2 : 0;
  // 9. Class boost
  const classBoost = MEMORY_CLASS_WEIGHT[c.memoryClass ?? "semantic"] ?? 0;
  // 10. Decay boost
  const ds = Number.isFinite(c.decayScore) ? Math.max(0, Math.min(1, c.decayScore)) : 1.0;
  const decayBoost = (ds - 0.5) * 0.2;
  // 11. Distilled penalty
  const distilledPenalty = c.distilledTo ? -0.15 : 0;
  // 12. Source priority
  const prio = Number.isFinite(c.sourcePriority) ? Math.max(0, Math.min(100, c.sourcePriority)) : 0;
  const priorityBoost = (prio / 100) * 0.08;

  return sLex * 1.2 + sVec + sDense * 1.5 + recencyBoost * 0.05 + bothBonus
    + confidenceBoost + versionBoost + conflictPenalty + classBoost + decayBoost
    + distilledPenalty + priorityBoost;
}

/* ══════════════════════════════════════════════════════════════════
 * 6. ILIKE 通配符转义
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 转义 SQL ILIKE 模式中的特殊字符（%, _, \）。
 * 防止用户输入 '%' 匹配全表记忆导致信息泄露。
 */
export function escapeIlikePat(s: string): string {
  return s.replace(/[%_\\]/g, ch => "\\" + ch);
}
