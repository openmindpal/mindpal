// ─── skill-video-extract ── 视频内容提取引擎 ────────────────────
// 从视频中提取文字：音轨→STT转录 + 关键帧→Vision OCR
// 需要 SKILL_STT_ENDPOINT（Whisper API）和/或 SKILL_LLM_ENDPOINT（Vision LLM）
//
// 输入: { videoUrl?, videoBase64?, format?, language?, extractAudio?, extractFrames?, frameIntervalSec?, maxFrames? }
// 输出: { text, audioTranscript, frameTexts, language, durationMs, wordCount, confidence }

"use strict";

// ─── API 配置 ────────────────────────────────────────────────────
function resolveSttConfig() {
  var endpoint = String(
    process.env.SKILL_STT_ENDPOINT ||
    process.env.SKILL_WHISPER_ENDPOINT ||
    ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_STT_API_KEY || process.env.SKILL_LLM_API_KEY || "").trim() || null,
    model: String(process.env.SKILL_STT_MODEL || "whisper-1").trim(),
    timeoutMs: Math.max(10000, Number(process.env.SKILL_STT_TIMEOUT_MS) || 180000),
  };
}

function resolveVisionConfig() {
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

// 视频处理服务配置（ffmpeg API / 视频处理微服务）
function resolveVideoProcessConfig() {
  var endpoint = String(
    process.env.SKILL_VIDEO_PROCESS_ENDPOINT || ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_VIDEO_PROCESS_API_KEY || "").trim() || null,
    timeoutMs: Math.max(10000, Number(process.env.SKILL_VIDEO_PROCESS_TIMEOUT_MS) || 300000),
  };
}

// ─── 通过视频处理服务提取音轨和关键帧 ──────────────────────────
async function extractMediaFromVideo(cfg, videoData, format, frameIntervalSec, maxFrames) {
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        video: videoData,
        format: format || "mp4",
        extractAudio: true,
        extractFrames: true,
        frameIntervalSec: frameIntervalSec || 30,
        maxFrames: maxFrames || 20,
        audioFormat: "wav",
        frameFormat: "jpeg",
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
    // 期望返回: { audioBase64, audioDurationMs, frames: [{timestamp, imageBase64}] }
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── STT 音轨转录 ───────────────────────────────────────────────
async function transcribeAudio(cfg, audioBase64, language) {
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var body = { model: cfg.model, file: audioBase64, response_format: "json" };
    if (language) body.language = language;

    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();
    return {
      transcript: String(data.text || ""),
      language: String(data.language || language || ""),
      durationMs: typeof data.duration === "number" ? Math.round(data.duration * 1000) : null,
      confidence: 0.9,
    };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Vision LLM 关键帧 OCR ──────────────────────────────────────
async function ocrFrame(cfg, frameBase64, timestamp) {
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var imgUrl = "data:image/jpeg;base64," + frameBase64;
    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: "你是一个OCR文字识别引擎。只输出图片中可见的文字，不要描述图片内容。如果没有文字输出空字符串。" },
          {
            role: "user",
            content: [
              { type: "text", text: "请识别这张视频帧中的所有文字（PPT文字、字幕、标注等）。只输出文字内容，不需要其他说明。" },
              { type: "image_url", image_url: { url: imgUrl, detail: "high" } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 1024,
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();
    var text = String(
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ""
    ).trim();
    return { timestamp: timestamp, text: text, confidence: text ? 0.75 : 0 };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 合并音轨+关键帧文字 ────────────────────────────────────────
function mergeResults(audioResult, frameResults) {
  var parts = [];

  if (audioResult && audioResult.transcript) {
    parts.push("## 音轨转录\n\n" + audioResult.transcript);
  }

  var validFrames = (frameResults || []).filter(function (f) {
    return f && f.text && f.text.trim();
  });
  if (validFrames.length > 0) {
    parts.push("## 关键帧文字\n");
    for (var i = 0; i < validFrames.length; i++) {
      var f = validFrames[i];
      var ts = typeof f.timestamp === "number"
        ? "[" + formatTimestamp(f.timestamp) + "] "
        : "";
      parts.push(ts + f.text.trim());
    }
  }

  return parts.join("\n\n");
}

function formatTimestamp(ms) {
  var sec = Math.floor(ms / 1000);
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

// ─── 解析视频数据 ────────────────────────────────────────────────
async function resolveVideoData(videoUrl, videoBase64) {
  if (videoBase64) return videoBase64;
  if (videoUrl) {
    if (videoUrl.startsWith("data:")) {
      var parts = videoUrl.split(",");
      return parts[1] || null;
    }
    try {
      var res = await fetch(videoUrl);
      if (!res.ok) return null;
      var buf = await res.arrayBuffer();
      var bytes = new Uint8Array(buf);
      var bin = "";
      for (var i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      return typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ─── 主入口 ──────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  var input = req && req.input ? req.input : {};
  var videoUrl = input.videoUrl ? String(input.videoUrl) : null;
  var videoBase64 = input.videoBase64 ? String(input.videoBase64) : null;
  var format = String(input.format || "mp4").toLowerCase();
  var language = input.language ? String(input.language) : "";
  var extractAudio = input.extractAudio !== false;
  var extractFrames = input.extractFrames !== false;
  var frameIntervalSec = Number(input.frameIntervalSec) || 30;
  var maxFrames = Number(input.maxFrames) || 20;

  if (!videoUrl && !videoBase64) {
    return {
      text: "", audioTranscript: "", frameTexts: [],
      language: "", durationMs: 0, wordCount: 0, confidence: 0,
      _error: "未提供视频数据",
    };
  }

  // 检查必要的 API 配置
  var videoCfg = resolveVideoProcessConfig();
  var sttCfg = resolveSttConfig();
  var visionCfg = resolveVisionConfig();

  if (!videoCfg) {
    return {
      text: "", audioTranscript: "", frameTexts: [],
      language: "", durationMs: 0, wordCount: 0, confidence: 0,
      _error: "未配置视频处理服务 (SKILL_VIDEO_PROCESS_ENDPOINT)，无法提取视频内容。该服务需要 ffmpeg 支持，用于分离音轨和提取关键帧。",
    };
  }

  // 1. 获取视频数据
  var videoData = await resolveVideoData(videoUrl, videoBase64);
  if (!videoData) {
    return {
      text: "", audioTranscript: "", frameTexts: [],
      language: "", durationMs: 0, wordCount: 0, confidence: 0,
      _error: "无法获取视频数据",
    };
  }

  // 2. 调用视频处理服务提取音轨+关键帧
  var media = await extractMediaFromVideo(videoCfg, videoData, format, frameIntervalSec, maxFrames);
  if (!media) {
    return {
      text: "", audioTranscript: "", frameTexts: [],
      language: "", durationMs: 0, wordCount: 0, confidence: 0,
      _error: "视频处理服务调用失败",
    };
  }

  // 3. 并行执行音轨转录 + 关键帧OCR
  var audioPromise = null;
  var framePromises = [];

  if (extractAudio && media.audioBase64 && sttCfg) {
    audioPromise = transcribeAudio(sttCfg, media.audioBase64, language);
  }

  if (extractFrames && Array.isArray(media.frames) && visionCfg) {
    for (var i = 0; i < media.frames.length; i++) {
      var frame = media.frames[i];
      if (frame.imageBase64) {
        framePromises.push(ocrFrame(visionCfg, frame.imageBase64, frame.timestamp || 0));
      }
    }
  }

  // 等待所有异步任务
  var results = await Promise.all([
    audioPromise || Promise.resolve(null),
    Promise.all(framePromises),
  ]);

  var audioResult = results[0];
  var frameResults = results[1] || [];

  // 4. 合并结果
  var mergedText = mergeResults(audioResult, frameResults);
  var validFrameTexts = frameResults.filter(function (f) { return f && f.text; });

  // 计算综合置信度
  var confParts = [];
  if (audioResult && audioResult.confidence) confParts.push(audioResult.confidence);
  for (var j = 0; j < validFrameTexts.length; j++) {
    if (validFrameTexts[j].confidence) confParts.push(validFrameTexts[j].confidence);
  }
  var avgConf = confParts.length > 0
    ? confParts.reduce(function (a, b) { return a + b; }, 0) / confParts.length
    : 0;

  return {
    text: mergedText,
    audioTranscript: audioResult ? audioResult.transcript || "" : "",
    frameTexts: validFrameTexts,
    language: (audioResult && audioResult.language) || language || "",
    durationMs: media.audioDurationMs || (audioResult && audioResult.durationMs) || 0,
    wordCount: mergedText.replace(/\s+/g, " ").trim().split(/\s+/).length,
    confidence: Math.max(0, Math.min(1, avgConf)),
  };
};
