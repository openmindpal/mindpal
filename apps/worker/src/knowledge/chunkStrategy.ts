/**
 * chunkStrategy.ts — 智能分块策略引擎
 *
 * 提供多种文档分块策略（固定长度 / 段落边界 / 递归分块 / 语义分块），
 * 所有策略实现统一接口，支持动态切换与配置化。
 *
 * 依赖方向：
 *   packages/shared (本文件)
 *   → worker/knowledge/processor.ts
 *   → api/skills/knowledge-rag/modules/repo.ts
 */

import crypto from "node:crypto";

// ─── 类型定义 ──────────────────────────────────────────────────

/** 分块策略名称 */
export type ChunkStrategyName = "fixed" | "paragraph" | "recursive" | "semantic" | "parent_child" | "table_aware" | "code_aware";

/** 单个分块输出 */
export interface ChunkResult {
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  snippet: string;
  contentDigest: string;
  /** 分块策略名称 */
  strategyName: ChunkStrategyName;
  /** 层级路径，如 "H2>H3>paragraph" */
  hierarchyPath: string | null;
  /** 与前一个chunk的overlap字符数 */
  overlapBefore: number;
  /** 与后一个chunk的overlap字符数 */
  overlapAfter: number;
}

/** 分块策略配置（通用） */
export interface ChunkStrategyConfig {
  /** 策略名称 */
  strategy: ChunkStrategyName;
  /** 最大分块长度（字符数） */
  maxLen: number;
  /** 重叠区间长度（字符数）—— 仅 recursive / semantic 使用 */
  overlap: number;
  /** 段落分隔符列表（仅 paragraph / recursive 使用） */
  separators: string[];
  /** 语义分块的相似度阈值（仅 semantic 使用，0~1） */
  semanticThreshold: number;
  /** 语义分块的嵌入函数（仅 semantic 使用） */
  embedFn: ((texts: string[]) => Promise<number[][]>) | null;
  /** Parent-Child 模式: 父块最大长度 */
  parentMaxLen: number;
  /** Parent-Child 模式: 子块最大长度 */
  childMaxLen: number;
  /** 是否启用表格感知 */
  tableAware: boolean;
  /** 是否启用代码感知 */
  codeAware: boolean;
}

/** 分块策略接口 */
export interface ChunkStrategy {
  readonly name: ChunkStrategyName;
  chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]>;
}

// ─── 工具函数 ──────────────────────────────────────────────────

function sha256Chunk(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 构建默认配置 */
export function defaultChunkConfig(overrides?: Partial<ChunkStrategyConfig>): ChunkStrategyConfig {
  return {
    strategy: overrides?.strategy ?? "recursive",
    maxLen: overrides?.maxLen ?? 600,
    overlap: overrides?.overlap ?? 80,
    separators: overrides?.separators ?? DEFAULT_SEPARATORS,
    semanticThreshold: overrides?.semanticThreshold ?? 0.5,
    embedFn: overrides?.embedFn ?? null,
    parentMaxLen: overrides?.parentMaxLen ?? 2000,
    childMaxLen: overrides?.childMaxLen ?? 300,
    tableAware: overrides?.tableAware ?? true,
    codeAware: overrides?.codeAware ?? true,
  };
}

/** 默认分隔符列表（递归策略按优先级从高到低尝试） */
export const DEFAULT_SEPARATORS = [
  "\n## ",     // H2 标题
  "\n### ",    // H3 标题
  "\n#### ",   // H4 标题
  "\n\n",      // 空行（段落边界）
  "\n",        // 换行
  "。",        // 中文句号
  ".",         // 英文句号
  "；",        // 中文分号
  ";",         // 英文分号
  " ",         // 空格
  "",          // 字符级（兜底）
];

// ─── 固定长度分块策略 ──────────────────────────────────────────

class FixedChunkStrategy implements ChunkStrategy {
  readonly name: ChunkStrategyName = "fixed";

  async chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]> {
    const results: ChunkResult[] = [];
    const maxLen = Math.max(50, config.maxLen);
    let i = 0;
    let idx = 0;
    while (i < text.length) {
      const end = Math.min(text.length, i + maxLen);
      const snippet = text.slice(i, end);
      results.push({
        chunkIndex: idx++,
        startOffset: i,
        endOffset: end,
        snippet,
        contentDigest: sha256Chunk(snippet),
        strategyName: "fixed",
        hierarchyPath: null,
        overlapBefore: 0,
        overlapAfter: 0,
      });
      i = end;
    }
    return results;
  }
}

// ─── 段落边界分块策略 ──────────────────────────────────────────

class ParagraphChunkStrategy implements ChunkStrategy {
  readonly name: ChunkStrategyName = "paragraph";

  async chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]> {
    const maxLen = Math.max(50, config.maxLen);

    // 按标题和空行分段
    const segments = splitByParagraphs(text);

    // 将小段合并到 maxLen 限制内，过大段截断
    const results: ChunkResult[] = [];
    let buffer = "";
    let bufferStart = 0;
    let currentPath = "";
    let idx = 0;

    for (const seg of segments) {
      const newPath = seg.hierarchyPath || currentPath;

      // 如果累积的 buffer + 新段超过 maxLen，先输出 buffer
      if (buffer.length > 0 && buffer.length + seg.text.length > maxLen) {
        results.push({
          chunkIndex: idx++,
          startOffset: bufferStart,
          endOffset: bufferStart + buffer.length,
          snippet: buffer,
          contentDigest: sha256Chunk(buffer),
          strategyName: "paragraph",
          hierarchyPath: currentPath || null,
          overlapBefore: 0,
          overlapAfter: 0,
        });
        buffer = "";
        bufferStart = seg.startOffset;
      }

      if (buffer.length === 0) {
        bufferStart = seg.startOffset;
        currentPath = newPath;
      }

      // 如果单段本身超过 maxLen，截断输出
      if (seg.text.length > maxLen) {
        // 先输出已有 buffer
        if (buffer.length > 0) {
          results.push({
            chunkIndex: idx++,
            startOffset: bufferStart,
            endOffset: bufferStart + buffer.length,
            snippet: buffer,
            contentDigest: sha256Chunk(buffer),
            strategyName: "paragraph",
            hierarchyPath: currentPath || null,
            overlapBefore: 0,
            overlapAfter: 0,
          });
          buffer = "";
        }
        // 截断大段
        let si = 0;
        while (si < seg.text.length) {
          const end = Math.min(seg.text.length, si + maxLen);
          const snippet = seg.text.slice(si, end);
          results.push({
            chunkIndex: idx++,
            startOffset: seg.startOffset + si,
            endOffset: seg.startOffset + end,
            snippet,
            contentDigest: sha256Chunk(snippet),
            strategyName: "paragraph",
            hierarchyPath: newPath || null,
            overlapBefore: 0,
            overlapAfter: 0,
          });
          si = end;
        }
        bufferStart = seg.startOffset + seg.text.length;
        currentPath = newPath;
        continue;
      }

      buffer += seg.text;
      currentPath = newPath;
    }

    // 输出剩余 buffer
    if (buffer.length > 0) {
      results.push({
        chunkIndex: idx++,
        startOffset: bufferStart,
        endOffset: bufferStart + buffer.length,
        snippet: buffer,
        contentDigest: sha256Chunk(buffer),
        strategyName: "paragraph",
        hierarchyPath: currentPath || null,
        overlapBefore: 0,
        overlapAfter: 0,
      });
    }

    return results;
  }
}

/** 按标题/空行/换行分段 */
function splitByParagraphs(text: string): Array<{ text: string; startOffset: number; hierarchyPath: string }> {
  const segments: Array<{ text: string; startOffset: number; hierarchyPath: string }> = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const headings: Array<{ level: number; title: string; offset: number }> = [];

  let match;
  while ((match = headingRegex.exec(text)) !== null) {
    headings.push({ level: match[1]!.length, title: match[2]!.trim(), offset: match.index });
  }

  // 按空行分段
  const parts = text.split(/\n\n+/);
  let offset = 0;
  let currentHeadings: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      offset += part.length + 2; // +2 for \n\n
      continue;
    }

    const actualStart = text.indexOf(part, offset);
    const startOff = actualStart >= 0 ? actualStart : offset;

    // 检测段内标题
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/m);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      // 更新层级路径
      while (currentHeadings.length >= level) currentHeadings.pop();
      currentHeadings.push(`H${level}:${title}`);
    }

    segments.push({
      text: part + "\n\n",
      startOffset: startOff,
      hierarchyPath: currentHeadings.join(">"),
    });

    offset = startOff + part.length;
  }

  return segments;
}

// ─── 递归分块策略 ──────────────────────────────────────────────

class RecursiveChunkStrategy implements ChunkStrategy {
  readonly name: ChunkStrategyName = "recursive";

  async chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]> {
    const maxLen = Math.max(50, config.maxLen);
    const overlap = Math.max(0, Math.min(Math.floor(maxLen / 2), config.overlap));
    const separators = config.separators.length > 0 ? config.separators : DEFAULT_SEPARATORS;

    const rawChunks = recursiveSplit(text, separators, maxLen, 0);

    // 应用 overlap 并构建结果
    const results: ChunkResult[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const rc = rawChunks[i]!;
      const prevOverlap = i > 0 && overlap > 0
        ? Math.min(overlap, rawChunks[i - 1]!.text.length)
        : 0;
      const nextOverlap = i < rawChunks.length - 1 && overlap > 0
        ? Math.min(overlap, rawChunks[i + 1]!.text.length)
        : 0;

      // 扩展 snippet 以包含 overlap 区域
      const overlapStart = Math.max(0, rc.startOffset - prevOverlap);
      const overlapEnd = Math.min(text.length, rc.endOffset + nextOverlap);
      const snippet = text.slice(overlapStart, overlapEnd);

      results.push({
        chunkIndex: i,
        startOffset: overlapStart,
        endOffset: overlapEnd,
        snippet,
        contentDigest: sha256Chunk(snippet),
        strategyName: "recursive",
        hierarchyPath: rc.hierarchyPath || null,
        overlapBefore: rc.startOffset - overlapStart,
        overlapAfter: overlapEnd - rc.endOffset,
      });
    }

    return results;
  }
}

type RawChunk = { text: string; startOffset: number; endOffset: number; hierarchyPath: string };

function recursiveSplit(
  text: string,
  separators: string[],
  maxLen: number,
  baseOffset: number,
): RawChunk[] {
  if (text.length <= maxLen) {
    return [{
      text,
      startOffset: baseOffset,
      endOffset: baseOffset + text.length,
      hierarchyPath: detectHierarchyPath(text),
    }];
  }

  // 尝试按当前分隔符切分
  for (let si = 0; si < separators.length; si++) {
    const sep = separators[si]!;
    if (sep === "") {
      // 字符级兜底：直接按 maxLen 截断
      const results: RawChunk[] = [];
      let pos = 0;
      while (pos < text.length) {
        const end = Math.min(text.length, pos + maxLen);
        const segment = text.slice(pos, end);
        results.push({
          text: segment,
          startOffset: baseOffset + pos,
          endOffset: baseOffset + end,
          hierarchyPath: detectHierarchyPath(segment),
        });
        pos = end;
      }
      return results;
    }

    const parts = splitKeepSeparator(text, sep);
    if (parts.length <= 1) continue;

    // 合并小段
    const merged = mergeSmallParts(parts, maxLen);
    if (merged.length <= 1 && merged[0]!.text.length > maxLen) continue;

    // 递归处理仍然过大的段
    const results: RawChunk[] = [];
    const remainingSeps = separators.slice(si + 1);
    let runningOffset = 0;
    for (const m of merged) {
      if (m.text.length <= maxLen) {
        results.push({
          text: m.text,
          startOffset: baseOffset + runningOffset,
          endOffset: baseOffset + runningOffset + m.text.length,
          hierarchyPath: detectHierarchyPath(m.text),
        });
      } else {
        const sub = recursiveSplit(m.text, remainingSeps, maxLen, baseOffset + runningOffset);
        results.push(...sub);
      }
      runningOffset += m.text.length;
    }
    return results;
  }

  // 所有分隔符都无法切分，强制按 maxLen 截断
  const results: RawChunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(text.length, pos + maxLen);
    const segment = text.slice(pos, end);
    results.push({
      text: segment,
      startOffset: baseOffset + pos,
      endOffset: baseOffset + end,
      hierarchyPath: detectHierarchyPath(segment),
    });
    pos = end;
  }
  return results;
}

/** 按分隔符切分但保留分隔符在前一段 */
function splitKeepSeparator(text: string, sep: string): Array<{ text: string }> {
  if (!sep) return [{ text }];
  const parts: Array<{ text: string }> = [];
  let lastIdx = 0;
  let searchIdx = 0;

  while (searchIdx < text.length) {
    const idx = text.indexOf(sep, searchIdx);
    if (idx < 0) break;
    // 包含分隔符在当前段
    const end = idx + sep.length;
    if (end > lastIdx) {
      parts.push({ text: text.slice(lastIdx, end) });
      lastIdx = end;
    }
    searchIdx = end;
  }
  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx) });
  }
  return parts;
}

/** 合并相邻小段使得每段不超过 maxLen */
function mergeSmallParts(parts: Array<{ text: string }>, maxLen: number): Array<{ text: string }> {
  const merged: Array<{ text: string }> = [];
  let buffer = "";
  for (const p of parts) {
    if (buffer.length + p.text.length <= maxLen) {
      buffer += p.text;
    } else {
      if (buffer) merged.push({ text: buffer });
      buffer = p.text;
    }
  }
  if (buffer) merged.push({ text: buffer });
  return merged;
}

/** 检测文本中的标题层级 */
function detectHierarchyPath(text: string): string {
  const headings: string[] = [];
  const lines = text.split("\n").slice(0, 10); // 只看前10行
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)/);
    if (m) headings.push(`H${m[1]!.length}:${m[2]!.trim().slice(0, 50)}`);
  }
  return headings.join(">");
}

// ─── 语义分块策略 ──────────────────────────────────────────────

class SemanticChunkStrategy implements ChunkStrategy {
  readonly name: ChunkStrategyName = "semantic";

  async chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]> {
    const maxLen = Math.max(50, config.maxLen);
    const threshold = config.semanticThreshold;
    const embedFn = config.embedFn;

    // 先按句子级别切分
    const sentences = splitSentences(text);
    if (sentences.length === 0) return [];

    // 如果没有 embedding 函数，降级到递归分块
    if (!embedFn) {
      const fallback = new RecursiveChunkStrategy();
      return fallback.chunk(text, config);
    }

    // 获取每个句子的 embedding
    const sentenceTexts = sentences.map(s => s.text);
    let embeddings: number[][];
    try {
      embeddings = await embedFn(sentenceTexts);
    } catch {
      // embedding 失败，降级到递归分块
      const fallback = new RecursiveChunkStrategy();
      return fallback.chunk(text, config);
    }

    if (embeddings.length !== sentences.length) {
      const fallback = new RecursiveChunkStrategy();
      return fallback.chunk(text, config);
    }

    // 计算相邻句子的余弦相似度，找到语义边界
    const boundaries: number[] = [0]; // 分块起始句子索引
    for (let i = 1; i < sentences.length; i++) {
      const sim = cosineSimilarity(embeddings[i - 1]!, embeddings[i]!);
      if (sim < threshold) {
        boundaries.push(i);
      }
    }

    // 将句子按语义边界分组，并确保不超过 maxLen
    const results: ChunkResult[] = [];
    let idx = 0;

    for (let bi = 0; bi < boundaries.length; bi++) {
      const start = boundaries[bi]!;
      const end = bi < boundaries.length - 1 ? boundaries[bi + 1]! : sentences.length;

      let groupText = "";
      let groupStart = sentences[start]!.startOffset;
      let groupEnd = groupStart;

      for (let si = start; si < end; si++) {
        const s = sentences[si]!;
        if (groupText.length + s.text.length > maxLen && groupText.length > 0) {
          // 输出当前组
          results.push({
            chunkIndex: idx++,
            startOffset: groupStart,
            endOffset: groupEnd,
            snippet: groupText,
            contentDigest: sha256Chunk(groupText),
            strategyName: "semantic",
            hierarchyPath: detectHierarchyPath(groupText),
            overlapBefore: 0,
            overlapAfter: 0,
          });
          groupText = "";
          groupStart = s.startOffset;
        }
        groupText += s.text;
        groupEnd = s.startOffset + s.text.length;
      }

      if (groupText.length > 0) {
        results.push({
          chunkIndex: idx++,
          startOffset: groupStart,
          endOffset: groupEnd,
          snippet: groupText,
          contentDigest: sha256Chunk(groupText),
          strategyName: "semantic",
          hierarchyPath: detectHierarchyPath(groupText),
          overlapBefore: 0,
          overlapAfter: 0,
        });
      }
    }

    return results;
  }
}

/** 按句子边界切分 */
function splitSentences(text: string): Array<{ text: string; startOffset: number }> {
  const results: Array<{ text: string; startOffset: number }> = [];
  // 支持中英文句子切分
  const regex = /[^。！？.!?\n]+[。！？.!?\n]?/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const t = match[0]!;
    if (t.trim().length > 0) {
      results.push({ text: t, startOffset: match.index });
    }
  }
  // 如果正则没匹配到任何句子（全文无标点），返回整段
  if (results.length === 0 && text.trim().length > 0) {
    results.push({ text, startOffset: 0 });
  }
  return results;
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ─── 策略注册表 ─────────────────────────────────────────

// ─── Parent-Child 分块策略 (Small2Big) ───────────────────
// 注意：此策略为可选扩展策略，不自动注册。
// 使用方应在启动时调用 registerAdvancedChunkStrategies() 或手动注册。

/**
 * Parent-Child (Small2Big) 分块策略
 *
 * 先将文本按大块 (parentMaxLen 约 2000 字符) 切分，
 * 再将每个大块内部拆分为小块 (childMaxLen 约 300 字符)。
 * 检索时匹配 child 块，返回其 parent 块提供更大的上下文窗口。
 *
 * 输出中：parent 块 chunkRole="parent"，child 块 chunkRole="child" + parentChunkIndex 指向父块索引。
 */
class ParentChildChunkStrategy implements ChunkStrategy {
  readonly name: ChunkStrategyName = "parent_child";

  async chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]> {
    const parentMaxLen = Math.max(200, config.parentMaxLen);
    const childMaxLen = Math.max(50, config.childMaxLen);
    const overlap = Math.max(0, Math.min(Math.floor(childMaxLen / 2), config.overlap));
    const results: ChunkResult[] = [];
    let idx = 0;

    // Step 1: 切分父块 (使用递归分块策略)
    const parentChunks = recursiveSplit(
      text,
      config.separators.length > 0 ? config.separators : DEFAULT_SEPARATORS,
      parentMaxLen,
      0,
    );

    for (let pi = 0; pi < parentChunks.length; pi++) {
      const parent = parentChunks[pi]!;
      const parentIdx = idx++;

      // 输出父块
      results.push({
        chunkIndex: parentIdx,
        startOffset: parent.startOffset,
        endOffset: parent.endOffset,
        snippet: parent.text,
        contentDigest: sha256Chunk(parent.text),
        strategyName: "parent_child",
        hierarchyPath: parent.hierarchyPath || null,
        overlapBefore: 0,
        overlapAfter: 0,
      });

      // Step 2: 将父块内部拆分为子块
      if (parent.text.length > childMaxLen) {
        const childRaw = recursiveSplit(
          parent.text,
          config.separators.length > 0 ? config.separators : DEFAULT_SEPARATORS,
          childMaxLen,
          parent.startOffset,
        );

        for (let ci = 0; ci < childRaw.length; ci++) {
          const child = childRaw[ci]!;
          const prevOverlap = ci > 0 && overlap > 0
            ? Math.min(overlap, childRaw[ci - 1]!.text.length)
            : 0;
          const nextOverlap = ci < childRaw.length - 1 && overlap > 0
            ? Math.min(overlap, childRaw[ci + 1]!.text.length)
            : 0;

          const overlapStart = Math.max(parent.startOffset, child.startOffset - prevOverlap);
          const overlapEnd = Math.min(parent.endOffset, child.endOffset + nextOverlap);
          const snippet = text.slice(overlapStart, overlapEnd);

          results.push({
            chunkIndex: idx++,
            startOffset: overlapStart,
            endOffset: overlapEnd,
            snippet,
            contentDigest: sha256Chunk(snippet),
            strategyName: "parent_child",
            hierarchyPath: `parent:${parentIdx}>${child.hierarchyPath || `child:${ci}`}`,
            overlapBefore: child.startOffset - overlapStart,
            overlapAfter: overlapEnd - child.endOffset,
          });
        }
      }
    }

    return results;
  }
}

// ─── Table-aware 分块策略 ───────────────────────────────
// 注意：此策略为可选扩展策略，不自动注册。

/**
 * 表格感知分块策略
 *
 * 在递归分块基础上，检测 Markdown 表格 / HTML table 边界，
 * 确保表格不会被跨行切断。整个表格作为一个原子块。
 */
class TableAwareChunkStrategy implements ChunkStrategy {
  readonly name: ChunkStrategyName = "table_aware";

  async chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]> {
    const maxLen = Math.max(50, config.maxLen);
    const overlap = Math.max(0, Math.min(Math.floor(maxLen / 2), config.overlap));

    // 提取表格区域和非表格区域
    const segments = splitByTableBoundaries(text);
    const rawChunks: RawChunk[] = [];

    for (const seg of segments) {
      if (seg.isTable) {
        // 表格作为原子块（即使超过 maxLen 也不切断）
        rawChunks.push({
          text: seg.text,
          startOffset: seg.startOffset,
          endOffset: seg.startOffset + seg.text.length,
          hierarchyPath: "table",
        });
      } else {
        // 非表格文本使用递归分块
        const separators = config.separators.length > 0 ? config.separators : DEFAULT_SEPARATORS;
        const sub = recursiveSplit(seg.text, separators, maxLen, seg.startOffset);
        rawChunks.push(...sub);
      }
    }

    // 应用 overlap
    const results: ChunkResult[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const rc = rawChunks[i]!;
      const prevOv = i > 0 && overlap > 0 && rc.hierarchyPath !== "table"
        ? Math.min(overlap, rawChunks[i - 1]!.text.length)
        : 0;
      const nextOv = i < rawChunks.length - 1 && overlap > 0 && rc.hierarchyPath !== "table"
        ? Math.min(overlap, rawChunks[i + 1]!.text.length)
        : 0;

      const overlapStart = Math.max(0, rc.startOffset - prevOv);
      const overlapEnd = Math.min(text.length, rc.endOffset + nextOv);
      const snippet = text.slice(overlapStart, overlapEnd);

      results.push({
        chunkIndex: i,
        startOffset: overlapStart,
        endOffset: overlapEnd,
        snippet,
        contentDigest: sha256Chunk(snippet),
        strategyName: "table_aware",
        hierarchyPath: rc.hierarchyPath || null,
        overlapBefore: rc.startOffset - overlapStart,
        overlapAfter: overlapEnd - rc.endOffset,
      });
    }

    return results;
  }
}

/** 分割文本为表格和非表格区域 */
function splitByTableBoundaries(text: string): Array<{ text: string; startOffset: number; isTable: boolean }> {
  const segments: Array<{ text: string; startOffset: number; isTable: boolean }> = [];

  // Markdown 表格模式: 连续的 | xxx | 行
  const tableRegex = /(?:^|\n)((?:\|[^\n]*\|\n?){2,})/gm;
  let lastEnd = 0;
  let match;

  while ((match = tableRegex.exec(text)) !== null) {
    const tableStart = match.index + (text[match.index] === "\n" ? 1 : 0);
    const tableEnd = match.index + match[0].length;

    // 表格前的文本
    if (tableStart > lastEnd) {
      segments.push({ text: text.slice(lastEnd, tableStart), startOffset: lastEnd, isTable: false });
    }

    // 表格本身
    segments.push({ text: text.slice(tableStart, tableEnd), startOffset: tableStart, isTable: true });
    lastEnd = tableEnd;
  }

  // 剩余文本
  if (lastEnd < text.length) {
    segments.push({ text: text.slice(lastEnd), startOffset: lastEnd, isTable: false });
  }

  return segments.filter(s => s.text.trim().length > 0);
}

// ─── Code-aware 分块策略 ────────────────────────────────
// 注意：此策略为可选扩展策略，不自动注册。

/**
 * 代码感知分块策略
 *
 * 在递归分块基础上，检测代码块 (```...```) 边界，
 * 保留完整函数/类不被切断。整个代码块作为原子块。
 */
class CodeAwareChunkStrategy implements ChunkStrategy {
  readonly name: ChunkStrategyName = "code_aware";

  async chunk(text: string, config: ChunkStrategyConfig): Promise<ChunkResult[]> {
    const maxLen = Math.max(50, config.maxLen);
    const overlap = Math.max(0, Math.min(Math.floor(maxLen / 2), config.overlap));

    // 提取代码块和非代码区域
    const segments = splitByCodeBlocks(text);
    const rawChunks: RawChunk[] = [];

    for (const seg of segments) {
      if (seg.isCode) {
        // 代码块作为原子块（即使超过 maxLen 也尽量不切断）
        if (seg.text.length <= maxLen * 3) {
          rawChunks.push({
            text: seg.text,
            startOffset: seg.startOffset,
            endOffset: seg.startOffset + seg.text.length,
            hierarchyPath: "code",
          });
        } else {
          // 超大代码块（>3x maxLen）按空行分割
          const separators = ["\n\n", "\n", ""];
          const sub = recursiveSplit(seg.text, separators, maxLen, seg.startOffset);
          for (const s of sub) s.hierarchyPath = `code>${s.hierarchyPath || "fragment"}`;
          rawChunks.push(...sub);
        }
      } else {
        const separators = config.separators.length > 0 ? config.separators : DEFAULT_SEPARATORS;
        const sub = recursiveSplit(seg.text, separators, maxLen, seg.startOffset);
        rawChunks.push(...sub);
      }
    }

    // 应用 overlap
    const results: ChunkResult[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const rc = rawChunks[i]!;
      const isCode = rc.hierarchyPath === "code";
      const prevOv = i > 0 && overlap > 0 && !isCode
        ? Math.min(overlap, rawChunks[i - 1]!.text.length)
        : 0;
      const nextOv = i < rawChunks.length - 1 && overlap > 0 && !isCode
        ? Math.min(overlap, rawChunks[i + 1]!.text.length)
        : 0;

      const overlapStart = Math.max(0, rc.startOffset - prevOv);
      const overlapEnd = Math.min(text.length, rc.endOffset + nextOv);
      const snippet = text.slice(overlapStart, overlapEnd);

      results.push({
        chunkIndex: i,
        startOffset: overlapStart,
        endOffset: overlapEnd,
        snippet,
        contentDigest: sha256Chunk(snippet),
        strategyName: "code_aware",
        hierarchyPath: rc.hierarchyPath || null,
        overlapBefore: rc.startOffset - overlapStart,
        overlapAfter: overlapEnd - rc.endOffset,
      });
    }

    return results;
  }
}

/** 分割文本为代码块和非代码区域 */
function splitByCodeBlocks(text: string): Array<{ text: string; startOffset: number; isCode: boolean }> {
  const segments: Array<{ text: string; startOffset: number; isCode: boolean }> = [];
  // 匹配 ```lang ... ``` 代码块
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastEnd = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // 代码块前的文本
    if (match.index > lastEnd) {
      segments.push({ text: text.slice(lastEnd, match.index), startOffset: lastEnd, isCode: false });
    }
    // 代码块本身
    segments.push({ text: match[0], startOffset: match.index, isCode: true });
    lastEnd = match.index + match[0].length;
  }

  // 剩余文本
  if (lastEnd < text.length) {
    segments.push({ text: text.slice(lastEnd), startOffset: lastEnd, isCode: false });
  }

  return segments.filter(s => s.text.trim().length > 0);
}

// ─── 策略注册表 ─────────────────────────────────────────

const _strategies = new Map<ChunkStrategyName, ChunkStrategy>();

export function registerChunkStrategy(strategy: ChunkStrategy): void {
  _strategies.set(strategy.name, strategy);
}

export function getChunkStrategy(name: ChunkStrategyName): ChunkStrategy {
  const s = _strategies.get(name);
  if (!s) throw new Error(`[chunkStrategy] 未知策略: ${name}，可用: ${Array.from(_strategies.keys()).join(", ")}`);
  return s;
}

export function listChunkStrategies(): ChunkStrategyName[] {
  return Array.from(_strategies.keys());
}

// ─── 初始化内置策略（OS 核心：仅注册通用基础策略）─────────

registerChunkStrategy(new FixedChunkStrategy());
registerChunkStrategy(new ParagraphChunkStrategy());
registerChunkStrategy(new RecursiveChunkStrategy());
registerChunkStrategy(new SemanticChunkStrategy());

// ─── 可插拔高级策略注册函数（按需调用）─────────────────────

/**
 * 注册高级分块策略（Parent-Child / Table-aware / Code-aware）
 *
 * 这些策略属于可选扩展能力，不是 OS 核心必须。
 * 使用方应在应用启动时按需调用此函数注册。
 * 也可通过 registerChunkStrategy() 单独注册。
 */
export function registerAdvancedChunkStrategies(): void {
  registerChunkStrategy(new ParentChildChunkStrategy());
  registerChunkStrategy(new TableAwareChunkStrategy());
  registerChunkStrategy(new CodeAwareChunkStrategy());
}

/** 导出高级策略类，供外部按需实例化注册 */
export { ParentChildChunkStrategy, TableAwareChunkStrategy, CodeAwareChunkStrategy };

// ─── 统一入口 ──────────────────────────────────────────────

/**
 * 智能分块入口 — 根据配置选择策略并执行分块
 *
 * @param text - 待分块文本
 * @param config - 分块配置（可选，使用默认配置）
 * @returns 分块结果数组
 */
export async function chunkText(
  text: string,
  config?: Partial<ChunkStrategyConfig>,
): Promise<ChunkResult[]> {
  const cfg = defaultChunkConfig(config);
  const strategy = getChunkStrategy(cfg.strategy);
  try {
    const results = await strategy.chunk(text, cfg);
    // 确保结果非空
    if (results.length === 0 && text.trim().length > 0) {
      // 降级到固定分块
      return getChunkStrategy("fixed").chunk(text, cfg);
    }
    return results;
  } catch {
    // 任何策略失败，降级到固定分块
    return getChunkStrategy("fixed").chunk(text, cfg);
  }
}

// chunkTextSync 已移除 — 假同步反模式。请使用 chunkText() 异步版本。

// ─── 从环境变量解析分块配置 ────────────────────────────────

export function resolveChunkConfigFromEnv(): Partial<ChunkStrategyConfig> {
  const strategy = (process.env.KNOWLEDGE_CHUNK_STRATEGY ?? "").trim() as ChunkStrategyName;
  const maxLen = Number(process.env.KNOWLEDGE_CHUNK_MAX_LEN ?? 0);
  const overlap = Number(process.env.KNOWLEDGE_CHUNK_OVERLAP ?? 0);
  const semanticThreshold = Number(process.env.KNOWLEDGE_CHUNK_SEMANTIC_THRESHOLD ?? 0);
  const separatorsRaw = (process.env.KNOWLEDGE_CHUNK_SEPARATORS ?? "").trim();

  const config: Partial<ChunkStrategyConfig> = {};
  if (strategy && ["fixed", "paragraph", "recursive", "semantic", "parent_child", "table_aware", "code_aware"].includes(strategy)) {
    config.strategy = strategy;
  }
  if (maxLen > 0) config.maxLen = Math.max(50, Math.min(10000, maxLen));
  if (overlap > 0) config.overlap = Math.max(0, Math.min(5000, overlap));
  if (semanticThreshold > 0) config.semanticThreshold = Math.max(0, Math.min(1, semanticThreshold));
  if (separatorsRaw) {
    try {
      const parsed = JSON.parse(separatorsRaw);
      if (Array.isArray(parsed)) config.separators = parsed.map(String);
    } catch { /* ignore */ }
  }

  return config;
}
