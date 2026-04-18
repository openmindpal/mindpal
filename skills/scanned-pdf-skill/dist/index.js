// ─── skill-scanned-pdf ── 扫描件PDF OCR增强引擎 ─────────────────
// 当标准PDF解析器提取文字不足时，通过逐页渲染+OCR恢复完整文字。
// 需要：PDF渲染服务（SKILL_PDF_RENDER_ENDPOINT）+ OCR服务 或 Vision LLM
//
// 输入: { pdfUrl?, pdfBase64?, existingText?, language?, minTextThreshold?, maxPages?, dpi? }
// 输出: { text, pageCount, ocrTriggered, wordCount, confidence, pageResults? }

"use strict";

// ─── API 配置 ────────────────────────────────────────────────────
function resolveOcrConfig() {
  var endpoint = String(process.env.SKILL_OCR_ENDPOINT || "").trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_OCR_API_KEY || "").trim() || null,
    timeoutMs: Math.max(5000, Number(process.env.SKILL_OCR_TIMEOUT_MS) || 60000),
  };
}

function resolveVisionConfig() {
  var endpoint = String(
    process.env.SKILL_LLM_ENDPOINT || process.env.DISTILL_LLM_ENDPOINT || ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_LLM_API_KEY || process.env.DISTILL_LLM_API_KEY || "").trim() || null,
    model: String(process.env.SKILL_VISION_MODEL || process.env.SKILL_LLM_MODEL || "gpt-4o").trim(),
    timeoutMs: Math.max(5000, Number(process.env.SKILL_LLM_TIMEOUT_MS) || 60000),
  };
}

// PDF渲染服务（将PDF页面渲染为图像）
function resolvePdfRenderConfig() {
  var endpoint = String(process.env.SKILL_PDF_RENDER_ENDPOINT || "").trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_PDF_RENDER_API_KEY || "").trim() || null,
    timeoutMs: Math.max(10000, Number(process.env.SKILL_PDF_RENDER_TIMEOUT_MS) || 120000),
  };
}

// ─── 获取PDF数据 ─────────────────────────────────────────────────
async function resolvePdfData(pdfUrl, pdfBase64) {
  if (pdfBase64) return pdfBase64;
  if (pdfUrl) {
    if (pdfUrl.startsWith("data:")) {
      var parts = pdfUrl.split(",");
      return parts[1] || null;
    }
    try {
      var res = await fetch(pdfUrl);
      if (!res.ok) return null;
      var buf = await res.arrayBuffer();
      var bytes = new Uint8Array(buf);
      var bin = "";
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ─── PDF渲染为图像序列 ──────────────────────────────────────────
async function renderPdfToImages(cfg, pdfBase64, maxPages, dpi) {
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        pdf: pdfBase64,
        maxPages: maxPages,
        dpi: dpi,
        format: "png",
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();
    // 期望返回: { pageCount, pages: [{page, imageBase64}] }
    return data;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 单页OCR：外部OCR API ────────────────────────────────────────
async function ocrPageWithApi(cfg, imageBase64, language) {
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
        mode: "text",
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();

    var text = "";
    if (data.text) {
      text = String(data.text);
    } else if (Array.isArray(data.regions || data.results || data.blocks)) {
      var items = data.regions || data.results || data.blocks;
      for (var i = 0; i < items.length; i++) {
        text += (text ? "\n" : "") + String(items[i].text || items[i].value || "");
      }
    }
    return { text: text, confidence: typeof data.confidence === "number" ? data.confidence : 0.8 };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 单页OCR：Vision LLM 降级 ───────────────────────────────────
async function ocrPageWithVision(cfg, imageBase64, language) {
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var langHint = language ? "（优先识别 " + language + " 语言）" : "";
  var imgUrl = "data:image/png;base64," + imageBase64;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "system",
            content: "你是一个精确的文档OCR引擎。请准确识别文档页面中的所有文字，按原始布局顺序输出纯文本，不要添加任何说明。",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "请识别这张文档页面中的所有文字内容" + langHint + "。保持原文排版顺序，只输出文字。" },
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
    var text = String(
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ""
    ).trim();
    return { text: text, confidence: text ? 0.7 : 0 };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 判断是否需要OCR ─────────────────────────────────────────────
function needsOcr(existingText, minTextThreshold) {
  if (!existingText) return true;
  var cleaned = existingText.replace(/\s+/g, " ").trim();
  var wordCount = cleaned ? cleaned.split(/\s+/).length : 0;
  return wordCount < minTextThreshold;
}

// ─── 主入口 ──────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  var input = req && req.input ? req.input : {};
  var pdfUrl = input.pdfUrl ? String(input.pdfUrl) : null;
  var pdfBase64 = input.pdfBase64 ? String(input.pdfBase64) : null;
  var existingText = input.existingText ? String(input.existingText) : "";
  var language = input.language ? String(input.language) : "";
  var minTextThreshold = Number(input.minTextThreshold) || 50;
  var maxPages = Math.min(Number(input.maxPages) || 100, 500);
  var dpi = Number(input.dpi) || 300;

  // 检查是否真的需要OCR
  if (!needsOcr(existingText, minTextThreshold)) {
    return {
      text: existingText,
      pageCount: 0,
      ocrTriggered: false,
      wordCount: existingText.replace(/\s+/g, " ").trim().split(/\s+/).length,
      confidence: 1.0,
    };
  }

  if (!pdfUrl && !pdfBase64) {
    return {
      text: existingText || "",
      pageCount: 0,
      ocrTriggered: false,
      wordCount: 0,
      confidence: 0,
      _error: "未提供PDF数据",
    };
  }

  // 检查必要的服务
  var renderCfg = resolvePdfRenderConfig();
  var ocrCfg = resolveOcrConfig();
  var visionCfg = resolveVisionConfig();

  if (!renderCfg) {
    return {
      text: existingText || "",
      pageCount: 0,
      ocrTriggered: false,
      wordCount: 0,
      confidence: 0,
      _error: "未配置PDF渲染服务 (SKILL_PDF_RENDER_ENDPOINT)，无法将PDF页面转为图像进行OCR",
    };
  }

  if (!ocrCfg && !visionCfg) {
    return {
      text: existingText || "",
      pageCount: 0,
      ocrTriggered: false,
      wordCount: 0,
      confidence: 0,
      _error: "未配置OCR服务 (SKILL_OCR_ENDPOINT) 或 Vision LLM (SKILL_LLM_ENDPOINT)",
    };
  }

  // 1. 获取PDF数据
  var pdfData = await resolvePdfData(pdfUrl, pdfBase64);
  if (!pdfData) {
    return {
      text: existingText || "",
      pageCount: 0,
      ocrTriggered: false,
      wordCount: 0,
      confidence: 0,
      _error: "无法获取PDF数据",
    };
  }

  // 2. 渲染PDF为图像序列
  var renderResult = await renderPdfToImages(renderCfg, pdfData, maxPages, dpi);
  if (!renderResult || !Array.isArray(renderResult.pages) || renderResult.pages.length === 0) {
    return {
      text: existingText || "",
      pageCount: 0,
      ocrTriggered: true,
      wordCount: 0,
      confidence: 0,
      _error: "PDF渲染服务返回空结果",
    };
  }

  // 3. 逐页OCR（并行处理，限制并发数）
  var concurrency = 3;
  var pageResults = [];
  var pages = renderResult.pages;

  for (var batch = 0; batch < pages.length; batch += concurrency) {
    var batchPages = pages.slice(batch, batch + concurrency);
    var batchPromises = batchPages.map(function (p) {
      // 优先外部OCR API，降级Vision LLM
      if (ocrCfg) {
        return ocrPageWithApi(ocrCfg, p.imageBase64, language).then(function (r) {
          if (r) return { page: p.page, text: r.text, confidence: r.confidence };
          if (visionCfg) {
            return ocrPageWithVision(visionCfg, p.imageBase64, language).then(function (v) {
              return v ? { page: p.page, text: v.text, confidence: v.confidence } : { page: p.page, text: "", confidence: 0 };
            });
          }
          return { page: p.page, text: "", confidence: 0 };
        });
      }
      return ocrPageWithVision(visionCfg, p.imageBase64, language).then(function (v) {
        return v ? { page: p.page, text: v.text, confidence: v.confidence } : { page: p.page, text: "", confidence: 0 };
      });
    });

    var batchResults = await Promise.all(batchPromises);
    for (var j = 0; j < batchResults.length; j++) {
      pageResults.push(batchResults[j]);
    }
  }

  // 4. 合并全部页面文字
  var allText = [];
  var totalConf = 0;
  var validPages = 0;

  for (var k = 0; k < pageResults.length; k++) {
    var pr = pageResults[k];
    if (pr.text && pr.text.trim()) {
      allText.push("--- 第 " + (pr.page || k + 1) + " 页 ---\n" + pr.text.trim());
      totalConf += pr.confidence;
      validPages++;
    }
  }

  var mergedText = allText.join("\n\n");
  var avgConf = validPages > 0 ? totalConf / validPages : 0;

  return {
    text: mergedText,
    pageCount: pageResults.length,
    ocrTriggered: true,
    wordCount: mergedText.replace(/\s+/g, " ").trim().split(/\s+/).length,
    confidence: Math.max(0, Math.min(1, avgConf)),
    pageResults: pageResults,
  };
};
