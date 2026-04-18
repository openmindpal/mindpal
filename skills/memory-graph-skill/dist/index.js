// ─── skill-memory-graph ── 跨Agent记忆网络 ─────────────────────────
// 计算任务间语义关联，构建记忆图谱边。
// 使用 minhash 向量计算文本相似度（与核心系统一致的算法），零外部依赖。
//
// 输入: { currentSummary, candidates, topK?, minSimilarity? }
// 输出: { relatedRuns, graphEdges }

"use strict";

// ─── Minhash 实现（与 @openslin/shared memoryCore 一致） ──────────
const MINHASH_K = 16;

function tokenize(text) {
  const t = String(text ?? "").toLowerCase();
  const tokens = [];
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    // CJK 统一汉字：单字作为 token
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens.push(t[i]);
      continue;
    }
    // ASCII 字母/数字：连续提取为一个 token
    if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
      let j = i + 1;
      while (j < t.length) {
        const c2 = t.charCodeAt(j);
        if ((c2 >= 0x61 && c2 <= 0x7a) || (c2 >= 0x30 && c2 <= 0x39)) j++;
        else break;
      }
      tokens.push(t.slice(i, j));
      i = j - 1;
    }
  }
  return tokens;
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function computeMinhash(text, k) {
  k = k || MINHASH_K;
  const tokens = tokenize(text);
  const shingles = new Set();
  for (let i = 0; i < tokens.length; i++) {
    shingles.add(tokens[i]);
    if (i + 1 < tokens.length) shingles.add(tokens[i] + " " + tokens[i + 1]);
  }
  if (shingles.size === 0) {
    const arr = new Array(k);
    for (let i = 0; i < k; i++) arr[i] = 0xffffffff;
    return arr;
  }
  const mins = new Array(k);
  for (let i = 0; i < k; i++) mins[i] = 0xffffffff;
  for (const s of shingles) {
    const base = hash32(s);
    for (let i = 0; i < k; i++) {
      const h = (base ^ hash32("seed" + i)) >>> 0;
      if (h < mins[i]) mins[i] = h;
    }
  }
  return mins;
}

function minhashOverlapScore(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let match = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) match++;
  }
  return match / a.length;
}

// ─── 直接 Jaccard（短文本精确计算） ──────────────────────────────
function directJaccard(textA, textB) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  const shinglesA = new Set();
  const shinglesB = new Set();
  for (let i = 0; i < tokensA.length; i++) {
    shinglesA.add(tokensA[i]);
    if (i + 1 < tokensA.length) shinglesA.add(tokensA[i] + " " + tokensA[i + 1]);
  }
  for (let i = 0; i < tokensB.length; i++) {
    shinglesB.add(tokensB[i]);
    if (i + 1 < tokensB.length) shinglesB.add(tokensB[i] + " " + tokensB[i + 1]);
  }
  if (shinglesA.size === 0 || shinglesB.size === 0) return 0;
  let intersection = 0;
  for (const s of shinglesA) {
    if (shinglesB.has(s)) intersection++;
  }
  const union = shinglesA.size + shinglesB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── 综合相似度（短文本用 Jaccard，长文本用 minhash） ─────────────
function computeSimilarity(textA, textB) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  // 短文本（<50 tokens）: 直接 Jaccard 更精确
  if (tokensA.length < 50 || tokensB.length < 50) {
    return directJaccard(textA, textB);
  }
  // 长文本: minhash 更高效
  const mhA = computeMinhash(textA);
  const mhB = computeMinhash(textB);
  return minhashOverlapScore(mhA, mhB);
}

// ─── 关系类型推断 ──────────────────────────────────────────────────
function inferRelationship(similarity, currentSummary, candidateSummary) {
  if (similarity > 0.7) return "continuation";   // 几乎相同的任务 → 延续
  if (similarity > 0.4) return "related";         // 高度相关
  if (similarity > 0.2) return "contextual";      // 上下文相关

  // 关键词匹配推断特殊关系
  const cLower = (currentSummary || "").toLowerCase();
  const tLower = (candidateSummary || "").toLowerCase();

  const retryKeywords = ["重试", "retry", "再次", "again", "修复", "fix"];
  if (retryKeywords.some((k) => cLower.includes(k) && tLower.includes(k))) return "retry";

  const refinementKeywords = ["优化", "improve", "改进", "refine", "更新", "update"];
  if (refinementKeywords.some((k) => cLower.includes(k))) return "refinement";

  return "weak";
}

// ─── 主入口 ────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  const input = req?.input ?? {};
  const currentSummary = String(input.currentSummary ?? "");
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const topK = Math.max(1, Math.min(20, Number(input.topK) || 5));
  const minSimilarity = Math.max(0, Math.min(1, Number(input.minSimilarity) || 0.15));

  if (!currentSummary || candidates.length === 0) {
    return { relatedRuns: [], graphEdges: [] };
  }

  // 计算每个候选任务的相似度
  const scored = candidates
    .map((c) => {
      const summary = String(c.summary ?? c.taskSummary ?? "");
      if (!summary) return null;
      const similarity = computeSimilarity(currentSummary, summary);
      return {
        runId: String(c.runId ?? ""),
        summary,
        phase: c.phase ?? null,
        createdAt: c.createdAt ?? null,
        similarity,
        relationship: inferRelationship(similarity, currentSummary, summary),
      };
    })
    .filter((c) => c && c.similarity >= minSimilarity && c.runId);

  // 按相似度排序，取 topK
  scored.sort((a, b) => b.similarity - a.similarity);
  const relatedRuns = scored.slice(0, topK).map((r) => ({
    runId: r.runId,
    similarity: Math.round(r.similarity * 1000) / 1000,
    summary: r.summary.slice(0, 200),
    relationship: r.relationship,
    phase: r.phase,
  }));

  // 构建图谱边
  const graphEdges = relatedRuns.map((r) => ({
    from: "current",
    to: r.runId,
    weight: r.similarity,
    reason: r.relationship,
  }));

  // 候选任务之间的关联（两两比较，只取高于阈值的）
  if (relatedRuns.length > 1 && relatedRuns.length <= 10) {
    for (let i = 0; i < relatedRuns.length; i++) {
      for (let j = i + 1; j < relatedRuns.length; j++) {
        const sim = computeSimilarity(relatedRuns[i].summary, relatedRuns[j].summary);
        if (sim >= minSimilarity) {
          graphEdges.push({
            from: relatedRuns[i].runId,
            to: relatedRuns[j].runId,
            weight: Math.round(sim * 1000) / 1000,
            reason: inferRelationship(sim, relatedRuns[i].summary, relatedRuns[j].summary),
          });
        }
      }
    }
  }

  return { relatedRuns, graphEdges };
};
