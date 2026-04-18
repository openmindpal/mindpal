// ─── skill-sparse-search ── BM25 稀疏向量检索引擎 ──────────────
// 纯本地实现，无需外部 API。提供四种操作：
//   tokenize  — 文本分词
//   compute   — 计算BM25稀疏向量
//   score     — 两个稀疏向量的相似度
//   search    — 在文档集合中检索
//
// 输入: { action, text?, query?, vectorA?, vectorB?, documents?, topK?, language?, k1?, b? }
// 输出: { tokens?, sparseVector?, score?, results?, termCount? }

"use strict";

// ─── 分词器 ──────────────────────────────────────────────────────

// 中文字符范围检测
function isChinese(ch) {
  var code = ch.charCodeAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df);
}

// 检测文本主要语言
function detectLanguage(text) {
  var zhCount = 0;
  var enCount = 0;
  for (var i = 0; i < Math.min(text.length, 500); i++) {
    if (isChinese(text[i])) zhCount++;
    else if (/[a-zA-Z]/.test(text[i])) enCount++;
  }
  return zhCount > enCount ? "zh" : "en";
}

// 英文停用词
var EN_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "it", "its", "they", "them", "their", "this", "that",
  "these", "those", "am", "if", "or", "as", "of", "at", "by", "for",
  "with", "about", "against", "between", "through", "during", "before",
  "after", "above", "below", "to", "from", "up", "down", "in", "out",
  "on", "off", "over", "under", "again", "further", "then", "once",
  "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "but", "and", "because", "until", "while", "what", "which", "who",
]);

// 中文停用词
var ZH_STOPWORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
  "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
  "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
  "们", "那", "些", "被", "让", "把", "从", "与", "及", "其",
  "而", "但", "还", "之", "么", "呢", "吧", "啊", "呀", "吗",
]);

/**
 * 对文本进行分词
 * 中文：逐字 unigram + bigram；英文：空格分词 + 词干化
 */
function tokenize(text, language) {
  if (!text) return [];
  var lang = language === "auto" || !language ? detectLanguage(text) : language;
  var normalized = text.toLowerCase().replace(/[\r\n\t]+/g, " ");
  var tokens = [];

  if (lang === "zh") {
    // 中文分词：unigram + bigram
    var chars = [];
    for (var i = 0; i < normalized.length; i++) {
      var ch = normalized[i];
      if (isChinese(ch)) {
        chars.push(ch);
      } else if (/[a-z0-9]/.test(ch)) {
        // 遇到英文/数字，收集为一个 token
        var word = ch;
        while (i + 1 < normalized.length && /[a-z0-9]/.test(normalized[i + 1])) {
          i++;
          word += normalized[i];
        }
        if (word.length >= 2 && !EN_STOPWORDS.has(word)) {
          tokens.push(word);
        }
      }
    }
    // unigrams
    for (var j = 0; j < chars.length; j++) {
      if (!ZH_STOPWORDS.has(chars[j])) {
        tokens.push(chars[j]);
      }
    }
    // bigrams
    for (var k = 0; k < chars.length - 1; k++) {
      var bigram = chars[k] + chars[k + 1];
      if (!ZH_STOPWORDS.has(bigram)) {
        tokens.push(bigram);
      }
    }
  } else {
    // 英文分词
    var words = normalized.split(/[^a-z0-9]+/).filter(function (w) {
      return w.length >= 2 && !EN_STOPWORDS.has(w);
    });
    // 简单词干化（去除常见后缀）
    tokens = words.map(function (w) {
      if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
      if (w.endsWith("tion") && w.length > 6) return w.slice(0, -4);
      if (w.endsWith("ness") && w.length > 6) return w.slice(0, -4);
      if (w.endsWith("ment") && w.length > 6) return w.slice(0, -4);
      if (w.endsWith("ly") && w.length > 4) return w.slice(0, -2);
      if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
      if (w.endsWith("er") && w.length > 4) return w.slice(0, -2);
      if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
      if (w.endsWith("s") && w.length > 3) return w.slice(0, -1);
      return w;
    });
  }

  return tokens;
}

// ─── BM25 稀疏向量计算 ──────────────────────────────────────────

/**
 * 计算文本的BM25稀疏向量
 * @returns {{[term: string]: number}} 稀疏向量（term → TF权重）
 */
function computeSparseVector(text, language, k1, b) {
  var K1 = typeof k1 === "number" ? k1 : 1.2;
  var B = typeof b === "number" ? b : 0.75;

  var tokens = tokenize(text, language);
  if (tokens.length === 0) return {};

  // 统计词频
  var tf = {};
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    tf[t] = (tf[t] || 0) + 1;
  }

  // 计算BM25词频分量（不含IDF，IDF在检索时结合语料库计算）
  var docLen = tokens.length;
  var avgDocLen = docLen; // 单文档场景，avgDocLen = docLen
  var vector = {};

  var terms = Object.keys(tf);
  for (var j = 0; j < terms.length; j++) {
    var term = terms[j];
    var freq = tf[term];
    // BM25 TF 分量: (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * docLen / avgDocLen))
    var tfScore = (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * docLen / avgDocLen));
    vector[term] = Math.round(tfScore * 10000) / 10000; // 保留4位小数
  }

  return vector;
}

// ─── 稀疏向量相似度 ─────────────────────────────────────────────

function sparseDotProduct(vecA, vecB) {
  if (!vecA || !vecB) return 0;
  var score = 0;
  var keysA = Object.keys(vecA);
  for (var i = 0; i < keysA.length; i++) {
    var term = keysA[i];
    if (vecB[term]) {
      score += vecA[term] * vecB[term];
    }
  }
  return score;
}

function sparseNorm(vec) {
  if (!vec) return 0;
  var sum = 0;
  var keys = Object.keys(vec);
  for (var i = 0; i < keys.length; i++) {
    var v = vec[keys[i]];
    sum += v * v;
  }
  return Math.sqrt(sum);
}

function sparseCosine(vecA, vecB) {
  var dot = sparseDotProduct(vecA, vecB);
  var normA = sparseNorm(vecA);
  var normB = sparseNorm(vecB);
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

// ─── 文档集合检索 ────────────────────────────────────────────────

function searchDocuments(query, documents, topK, language, k1, b) {
  if (!query || !Array.isArray(documents) || documents.length === 0) {
    return [];
  }

  var queryVec = computeSparseVector(query, language, k1, b);
  var queryTerms = Object.keys(queryVec);
  if (queryTerms.length === 0) return [];

  // 计算IDF（基于文档集合）
  var N = documents.length;
  var docFreq = {}; // term → 包含该term的文档数
  var docVectors = [];

  for (var i = 0; i < documents.length; i++) {
    var doc = documents[i];
    var vec = doc.sparseVector || computeSparseVector(doc.text || "", language, k1, b);
    docVectors.push(vec);
    var seen = {};
    var terms = Object.keys(vec);
    for (var j = 0; j < terms.length; j++) {
      if (!seen[terms[j]]) {
        docFreq[terms[j]] = (docFreq[terms[j]] || 0) + 1;
        seen[terms[j]] = true;
      }
    }
  }

  // 对每个文档计算BM25得分
  var results = [];
  for (var d = 0; d < documents.length; d++) {
    var dVec = docVectors[d];
    var score = 0;
    var matchedTerms = [];

    for (var q = 0; q < queryTerms.length; q++) {
      var term = queryTerms[q];
      if (dVec[term]) {
        // IDF = ln((N - df + 0.5) / (df + 0.5) + 1)
        var df = docFreq[term] || 0;
        var idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        score += idf * dVec[term] * queryVec[term];
        matchedTerms.push(term);
      }
    }

    if (score > 0) {
      results.push({
        id: documents[d].id || String(d),
        score: Math.round(score * 10000) / 10000,
        matchedTerms: matchedTerms,
      });
    }
  }

  // 按得分降序排列
  results.sort(function (a, b) { return b.score - a.score; });

  return results.slice(0, topK || 10);
}

// ─── 主入口 ──────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  var input = req && req.input ? req.input : {};
  var action = String(input.action || "").toLowerCase();
  var language = input.language ? String(input.language) : "auto";
  var k1 = typeof input.k1 === "number" ? input.k1 : 1.2;
  var b = typeof input.b === "number" ? input.b : 0.75;

  switch (action) {
    case "tokenize": {
      var text = input.text ? String(input.text) : "";
      var tokens = tokenize(text, language);
      return { tokens: tokens, termCount: tokens.length };
    }

    case "compute": {
      var text = input.text ? String(input.text) : "";
      var vec = computeSparseVector(text, language, k1, b);
      return { sparseVector: vec, termCount: Object.keys(vec).length };
    }

    case "score": {
      var vecA = input.vectorA || {};
      var vecB = input.vectorB || {};
      var score = sparseCosine(vecA, vecB);
      return { score: Math.round(score * 10000) / 10000 };
    }

    case "search": {
      var query = input.query ? String(input.query) : "";
      var docs = Array.isArray(input.documents) ? input.documents : [];
      var topK = Number(input.topK) || 10;
      var results = searchDocuments(query, docs, topK, language, k1, b);
      return { results: results, termCount: results.length };
    }

    default:
      return {
        _error: "未知操作类型: " + action + "。支持的操作: tokenize | compute | score | search",
      };
  }
};
