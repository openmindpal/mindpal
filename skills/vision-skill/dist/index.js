// ─── skill-vision ── 视觉分析引擎 ──────────────────────────────
// 通过 Vision LLM 分析图像内容，支持通用描述和定向提问。
// 需要 SKILL_LLM_ENDPOINT 指向支持 vision 的模型（如 gpt-4o / qwen-vl）。
// 无 LLM 时降级返回元信息。
//
// 输入: { imageUrl?, imageBase64?, mimeType?, question?, detail? }
// 输出: { description, answer?, tags, confidence }

"use strict";

// ─── LLM 配置 ──────────────────────────────────────────────────────
function resolveLlmConfig() {
  const endpoint = String(
    process.env.SKILL_LLM_ENDPOINT ||
    process.env.DISTILL_LLM_ENDPOINT ||
    ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint,
    apiKey: String(process.env.SKILL_LLM_API_KEY || process.env.DISTILL_LLM_API_KEY || "").trim() || null,
    model: String(process.env.SKILL_VISION_MODEL || process.env.SKILL_LLM_MODEL || "gpt-4o").trim(),
    timeoutMs: Math.max(5000, Number(process.env.SKILL_LLM_TIMEOUT_MS) || 60000),
  };
}

// ─── 构建图像 URL ──────────────────────────────────────────────────
function buildImageUrl(imageUrl, imageBase64, mimeType) {
  if (imageUrl) return imageUrl;
  if (imageBase64) {
    const mime = mimeType || "image/png";
    return "data:" + mime + ";base64," + imageBase64;
  }
  return null;
}

// ─── Vision LLM 分析 ──────────────────────────────────────────────
async function analyzeWithVisionLlm(cfg, imgUrl, question, detail) {
  const userContent = [];

  // 文本指令
  const prompt = question
    ? "请仔细观察这张图片，回答以下问题：" + question + "\n\n同时请提供图片的整体描述和相关标签。"
    : "请详细描述这张图片的内容，包括主要对象、场景、颜色、文字（如有）等信息，并提供相关标签。";

  userContent.push({ type: "text", text: prompt });
  userContent.push({
    type: "image_url",
    image_url: { url: imgUrl, detail: detail || "auto" },
  });

  const systemPrompt = "你是一个图像分析专家。请用 JSON 格式输出分析结果：\n" +
    '{"description":"图片整体描述","answer":"针对问题的回答(如无问题则为空字符串)","tags":["标签1","标签2"],"confidence":0.9}\n' +
    "只输出 JSON，不要有其他内容。";

  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    var text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    if (!text) return null;

    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 本地降级（无 LLM） ──────────────────────────────────────────
function analyzeLocal(imgUrl) {
  var tags = [];
  var desc = "图像已接收";

  if (imgUrl) {
    // 从 URL/data URI 提取基本信息
    if (imgUrl.startsWith("data:")) {
      var mimeMatch = imgUrl.match(/^data:([^;]+)/);
      var mime = mimeMatch ? mimeMatch[1] : "unknown";
      tags.push(mime);
      // 估算 base64 数据大小
      var b64Part = imgUrl.split(",")[1] || "";
      var sizeKB = Math.round((b64Part.length * 3) / 4 / 1024);
      desc = "base64 图像 (" + mime + ", ~" + sizeKB + "KB)";
      tags.push(sizeKB > 500 ? "large" : sizeKB > 100 ? "medium" : "small");
    } else {
      // URL 分析
      var ext = (imgUrl.split("?")[0].split(".").pop() || "").toLowerCase();
      if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tiff"].indexOf(ext) >= 0) {
        tags.push(ext);
      }
      desc = "远程图像 (" + (ext || "unknown") + ")";
      tags.push("url");
    }
  }

  return {
    description: desc + " — 需要配置 SKILL_LLM_ENDPOINT (vision model) 以获取完整分析",
    answer: "",
    tags: tags,
    confidence: 0.1,
  };
}

// ─── 主入口 ────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  var input = req && req.input ? req.input : {};
  var imageUrl = input.imageUrl ? String(input.imageUrl) : null;
  var imageBase64 = input.imageBase64 ? String(input.imageBase64) : null;
  var mimeType = input.mimeType ? String(input.mimeType) : "image/png";
  var question = input.question ? String(input.question) : "";
  var detail = input.detail ? String(input.detail) : "auto";

  var imgUrl = buildImageUrl(imageUrl, imageBase64, mimeType);
  if (!imgUrl) {
    return {
      description: "未提供图像数据",
      answer: "",
      tags: [],
      confidence: 0,
    };
  }

  // 尝试 Vision LLM 分析
  var llmCfg = resolveLlmConfig();
  if (llmCfg) {
    var result = await analyzeWithVisionLlm(llmCfg, imgUrl, question, detail);
    if (result) {
      return {
        description: String(result.description || ""),
        answer: String(result.answer || ""),
        tags: Array.isArray(result.tags) ? result.tags.map(String) : [],
        confidence: typeof result.confidence === "number" ? Math.max(0, Math.min(1, result.confidence)) : 0.85,
      };
    }
  }

  // LLM 不可用 → 降级到元信息提取
  return analyzeLocal(imgUrl);
};
