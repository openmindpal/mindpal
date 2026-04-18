// ─── skill-ocr ── 图像OCR文字提取引擎 ──────────────────────────
// 从图像中提取文字，支持外部 OCR API（Tesseract API / Azure Vision 等）
// 和 Vision LLM 降级两种模式。
//
// 输入: { imageUrl?, imageBase64?, mimeType?, language?, mode? }
// 输出: { text, language, wordCount, confidence, regions? }

"use strict";

// ─── OCR API 配置 ────────────────────────────────────────────────
function resolveOcrConfig() {
  var endpoint = String(
    process.env.SKILL_OCR_ENDPOINT || ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_OCR_API_KEY || "").trim() || null,
    timeoutMs: Math.max(5000, Number(process.env.SKILL_OCR_TIMEOUT_MS) || 60000),
  };
}

// Vision LLM 降级配置
function resolveLlmConfig() {
  var endpoint = String(
    process.env.SKILL_LLM_ENDPOINT ||
    process.env.DISTILL_LLM_ENDPOINT ||
    ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_LLM_API_KEY || process.env.DISTILL_LLM_API_KEY || "").trim() || null,
    model: String(process.env.SKILL_VISION_MODEL || process.env.SKILL_LLM_MODEL || "gpt-4o").trim(),
    timeoutMs: Math.max(5000, Number(process.env.SKILL_LLM_TIMEOUT_MS) || 60000),
  };
}

// ─── 构建图像 URL ────────────────────────────────────────────────
function buildImageUrl(imageUrl, imageBase64, mimeType) {
  if (imageUrl) return imageUrl;
  if (imageBase64) {
    var mime = mimeType || "image/png";
    return "data:" + mime + ";base64," + imageBase64;
  }
  return null;
}

// 提取 base64 数据
function extractBase64(imageUrl, imageBase64) {
  if (imageBase64) return imageBase64;
  if (imageUrl && imageUrl.startsWith("data:")) {
    var parts = imageUrl.split(",");
    return parts[1] || null;
  }
  return null;
}

// ─── 方式1: 外部 OCR API（Tesseract API / PaddleOCR API 等）────
async function ocrWithExternalApi(cfg, imageBase64, language, mode) {
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        image: imageBase64,
        language: language || "auto",
        mode: mode || "text",
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();

    // 标准化输出：兼容常见 OCR API 响应格式
    var text = "";
    var regions = [];
    var avgConf = 0;

    if (data.text) {
      // 简单格式：{ text, confidence }
      text = String(data.text);
      avgConf = typeof data.confidence === "number" ? data.confidence : 0.85;
    } else if (Array.isArray(data.regions || data.results || data.blocks)) {
      // 结构化格式：[{ text, bbox, confidence }]
      var items = data.regions || data.results || data.blocks;
      var totalConf = 0;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var t = String(item.text || item.value || "");
        text += (text ? "\n" : "") + t;
        totalConf += (typeof item.confidence === "number" ? item.confidence : 0.8);
        regions.push({
          text: t,
          bbox: item.bbox || item.boundingBox || null,
          confidence: typeof item.confidence === "number" ? item.confidence : 0.8,
        });
      }
      avgConf = items.length > 0 ? totalConf / items.length : 0;
    }

    if (!text) return null;

    var result = {
      text: text,
      language: String(data.language || language || ""),
      wordCount: text.replace(/\s+/g, " ").trim().split(/\s+/).length,
      confidence: Math.max(0, Math.min(1, avgConf)),
    };
    if (mode === "structured" && regions.length > 0) {
      result.regions = regions;
    }
    return result;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 方式2: Vision LLM 降级 OCR ─────────────────────────────────
async function ocrWithVisionLlm(cfg, imgUrl, language, mode) {
  var langHint = language ? "（优先识别 " + language + " 语言）" : "";
  var structuredHint = mode === "structured"
    ? '\n请按区域输出 JSON: {"text":"全部文字","regions":[{"text":"区域文字","confidence":0.9}],"language":"检测语言","confidence":0.9}'
    : '\n只输出 JSON: {"text":"提取的全部文字","language":"检测语言","confidence":0.9}';

  var prompt = "请仔细识别这张图片中的所有文字内容" + langHint + "。" +
    "包括印刷体、手写体、标签、水印等所有可见文字。" +
    "按从上到下、从左到右的阅读顺序输出。" + structuredHint;

  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: "你是一个精确的 OCR 文字识别引擎。只输出 JSON，不要有其他内容。" },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imgUrl, detail: "high" } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();
    var raw = String(
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ""
    ).trim();
    if (!raw) return null;

    var jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // 无 JSON，整段文字作为 OCR 结果
      return {
        text: raw,
        language: language || "",
        wordCount: raw.replace(/\s+/g, " ").trim().split(/\s+/).length,
        confidence: 0.6,
      };
    }

    var parsed = JSON.parse(jsonMatch[0]);
    var text = String(parsed.text || "");
    var result = {
      text: text,
      language: String(parsed.language || language || ""),
      wordCount: text.replace(/\s+/g, " ").trim().split(/\s+/).length,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.75,
    };
    if (mode === "structured" && Array.isArray(parsed.regions)) {
      result.regions = parsed.regions.map(function (r) {
        return {
          text: String(r.text || ""),
          bbox: r.bbox || null,
          confidence: typeof r.confidence === "number" ? r.confidence : 0.7,
        };
      });
    }
    return result;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 主入口 ──────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  var input = req && req.input ? req.input : {};
  var imageUrl = input.imageUrl ? String(input.imageUrl) : null;
  var imageBase64 = input.imageBase64 ? String(input.imageBase64) : null;
  var mimeType = input.mimeType ? String(input.mimeType) : "image/png";
  var language = input.language ? String(input.language) : "";
  var mode = input.mode ? String(input.mode) : "text";

  var imgUrl = buildImageUrl(imageUrl, imageBase64, mimeType);
  if (!imgUrl) {
    return { text: "", language: "", wordCount: 0, confidence: 0, _error: "未提供图像数据" };
  }

  // 优先：外部 OCR API
  var ocrCfg = resolveOcrConfig();
  if (ocrCfg) {
    var b64 = extractBase64(imageUrl, imageBase64);
    if (b64) {
      var result = await ocrWithExternalApi(ocrCfg, b64, language, mode);
      if (result) return result;
    }
  }

  // 降级：Vision LLM
  var llmCfg = resolveLlmConfig();
  if (llmCfg) {
    var llmResult = await ocrWithVisionLlm(llmCfg, imgUrl, language, mode);
    if (llmResult) return llmResult;
  }

  // 完全无可用 API
  return {
    text: "",
    language: "",
    wordCount: 0,
    confidence: 0,
    _error: "未配置 OCR 服务 (SKILL_OCR_ENDPOINT) 或 Vision LLM (SKILL_LLM_ENDPOINT)，无法执行文字提取",
  };
};
