// ─── skill-speech ── 语音处理引擎 ──────────────────────────────
// 支持 STT（语音→文字）和 TTS（文字→语音）双向处理。
// STT 三级降级链路: 讯飞语音听写 → Whisper 兼容 API → 多模态 LLM
// TTS: 通过 TTS API 合成语音。
// 无外部 API 时降级返回错误提示。
//
// 输入: { audioUrl?, audioBase64?, format?, language?, mode?, text?, voice? }
// 输出: { transcript?, language?, durationMs?, audioBase64?, confidence }

"use strict";

// ─── API 配置 ──────────────────────────────────────────────────────
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
    timeoutMs: Math.max(5000, Number(process.env.SKILL_STT_TIMEOUT_MS) || 120000),
  };
}

function resolveTtsConfig() {
  var endpoint = String(
    process.env.SKILL_TTS_ENDPOINT ||
    ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_TTS_API_KEY || process.env.SKILL_LLM_API_KEY || "").trim() || null,
    model: String(process.env.SKILL_TTS_MODEL || "tts-1").trim(),
    timeoutMs: Math.max(5000, Number(process.env.SKILL_TTS_TIMEOUT_MS) || 60000),
  };
}

// ─── 通用 LLM endpoint 降级（用 chat completions 做简易转录） ────
function resolveLlmFallbackConfig() {
  var endpoint = String(
    process.env.SKILL_LLM_ENDPOINT ||
    process.env.DISTILL_LLM_ENDPOINT ||
    ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint: endpoint,
    apiKey: String(process.env.SKILL_LLM_API_KEY || process.env.DISTILL_LLM_API_KEY || "").trim() || null,
    model: String(process.env.SKILL_LLM_MODEL || "gpt-4o-audio-preview").trim(),
    timeoutMs: Math.max(5000, Number(process.env.SKILL_LLM_TIMEOUT_MS) || 60000),
  };
}

// ─── 讯飞语音听写配置（首选 STT 通道） ─────────────────────────────
function resolveIflytekConfig() {
  var appId = String(process.env.SKILL_IFLYTEK_APP_ID || "").trim();
  var apiKey = String(process.env.SKILL_IFLYTEK_API_KEY || "").trim();
  var apiSecret = String(process.env.SKILL_IFLYTEK_API_SECRET || "").trim();
  if (!appId || !apiKey || !apiSecret) return null;
  return {
    appId: appId,
    apiKey: apiKey,
    apiSecret: apiSecret,
    host: "iat-api.xfyun.cn",
    path: "/v2/iat",
    hostUrl: "wss://iat-api.xfyun.cn/v2/iat",
    timeoutMs: Math.max(10000, Number(process.env.SKILL_IFLYTEK_TIMEOUT_MS) || 30000),
  };
}

// ─── 讯飞鉴权 URL 构建（HMAC-SHA256 签名） ────────────────────────
function buildIflytekAuthUrl(cfg) {
  var crypto = require("crypto");
  var date = new Date().toUTCString();
  var signatureOrigin = "host: " + cfg.host + "\ndate: " + date + "\nGET " + cfg.path + " HTTP/1.1";
  var signatureSha = crypto
    .createHmac("sha256", cfg.apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  var authorizationOrigin =
    'api_key="' + cfg.apiKey + '", algorithm="hmac-sha256", ' +
    'headers="host date request-line", signature="' + signatureSha + '"';
  var authorization = Buffer.from(authorizationOrigin).toString("base64");
  return (
    cfg.hostUrl +
    "?authorization=" + encodeURIComponent(authorization) +
    "&date=" + encodeURIComponent(date) +
    "&host=" + encodeURIComponent(cfg.host)
  );
}

// ─── 讯飞音频格式映射 ─────────────────────────────────────────────
function mapIflytekEncoding(format) {
  // 讯飞支持: raw(PCM), speex, speex-wb, lame(MP3)
  switch ((format || "").toLowerCase()) {
    case "mp3":  return { encoding: "lame",     format: "audio/L16;rate=16000" };
    case "wav":  return { encoding: "raw",      format: "audio/L16;rate=16000" };
    case "pcm":  return { encoding: "raw",      format: "audio/L16;rate=16000" };
    case "ogg":  return { encoding: "raw",      format: "audio/L16;rate=16000" };
    case "webm": return { encoding: "raw",      format: "audio/L16;rate=16000" };
    default:     return { encoding: "raw",      format: "audio/L16;rate=16000" };
  }
}

// ─── 讯飞语言码映射 ──────────────────────────────────────────────
function mapIflytekLanguage(language) {
  if (!language) return { language: "zh_cn", accent: "mandarin" };
  var l = language.toLowerCase();
  if (l.startsWith("en")) return { language: "en_us", accent: "" };
  if (l.startsWith("ja")) return { language: "ja_jp", accent: "" };
  if (l.startsWith("ko")) return { language: "ko_kr", accent: "" };
  if (l.startsWith("zh")) {
    if (l.indexOf("yue") >= 0 || l.indexOf("cantonese") >= 0)
      return { language: "zh_cn", accent: "cantonese" };
    return { language: "zh_cn", accent: "mandarin" };
  }
  return { language: "zh_cn", accent: "mandarin" };
}

// ─── 讯飞语音听写 WebSocket STT ──────────────────────────────────
async function transcribeWithIflytek(cfg, audioBase64, format, language) {
  // 加载 WebSocket（优先 ws 模块，降级 globalThis.WebSocket）
  var WS;
  try { WS = require("ws"); } catch (_e) { /* ignore */ }
  if (!WS) {
    try { WS = globalThis.WebSocket; } catch (_e2) { /* ignore */ }
  }
  if (!WS) return null;

  var url = buildIflytekAuthUrl(cfg);
  var enc = mapIflytekEncoding(format);
  var lang = mapIflytekLanguage(language);

  return new Promise(function (resolve) {
    var ws;
    try { ws = new WS(url); } catch (_e) { resolve(null); return; }

    var resultText = "";
    var resolved = false;
    function done(val) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_e) { /* ignore */ }
      resolve(val);
    }

    var timer = setTimeout(function () { done(null); }, cfg.timeoutMs);

    // 解码音频，拆分为帧（每帧 1280 字节 ≈ 40ms @16kHz 16bit）
    var audioBuffer = Buffer.from(audioBase64, "base64");
    var frameSize = 1280;

    var onOpen = function () {
      var totalFrames = Math.ceil(audioBuffer.length / frameSize);
      if (totalFrames === 0) totalFrames = 1;

      for (var i = 0; i < totalFrames; i++) {
        var start = i * frameSize;
        var end = Math.min(start + frameSize, audioBuffer.length);
        var chunk = audioBuffer.slice(start, end);
        // status: 0=首帧 1=中间帧 2=末帧
        var status = totalFrames === 1 ? 2 : (i === 0 ? 0 : (i === totalFrames - 1 ? 2 : 1));

        var frame = {
          data: {
            status: status,
            format: enc.format,
            encoding: enc.encoding,
            audio: chunk.toString("base64"),
          },
        };
        // 首帧附带 common + business
        if (i === 0) {
          frame.common = { app_id: cfg.appId };
          frame.business = {
            language: lang.language,
            domain: "iat",
            accent: lang.accent || "mandarin",
            vad_eos: 3000,
            dwa: "wpgs",
            ptt: 1,
          };
        }
        ws.send(JSON.stringify(frame));
      }
    };

    var onMessage = function (event) {
      try {
        var raw = typeof event === "string" ? event : (event.data !== undefined ? event.data : event);
        var resp = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (resp.code !== 0) { done(null); return; }
        // 提取识别文字
        if (resp.data && resp.data.result) {
          var wsArr = resp.data.result.ws || [];
          for (var w = 0; w < wsArr.length; w++) {
            var cwArr = wsArr[w].cw || [];
            for (var c = 0; c < cwArr.length; c++) {
              resultText += cwArr[c].w || "";
            }
          }
        }
        // status=2 表示最终结果
        if (resp.data && resp.data.status === 2) {
          var detectedLang = lang.language === "zh_cn" ? "zh-CN" :
            lang.language === "en_us" ? "en-US" :
            lang.language === "ja_jp" ? "ja-JP" :
            lang.language === "ko_kr" ? "ko-KR" : (language || "");
          done({
            transcript: resultText.trim(),
            language: detectedLang,
            durationMs: null,
            confidence: 0.92,
          });
        }
      } catch (_e) { /* 解析失败继续等下一帧 */ }
    };

    var onError = function () { done(null); };
    var onClose = function () { done(resultText ? { transcript: resultText.trim(), language: language || "", durationMs: null, confidence: 0.85 } : null); };

    // ws 模块使用 .on() 事件，浏览器 WebSocket 使用 .onXxx 属性
    if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("close", onClose);
    } else {
      ws.onopen = onOpen;
      ws.onmessage = onMessage;
      ws.onerror = onError;
      ws.onclose = onClose;
    }
  });
}

// ─── STT: OpenAI Whisper 兼容 API ─────────────────────────────────
async function transcribeWithWhisper(cfg, audioData, format, language) {
  // Whisper API 使用 multipart/form-data
  // 但在沙箱中构造 FormData 可能受限，改用 JSON 方式（如果 endpoint 支持）
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var body = {
    model: cfg.model,
    file: audioData,   // base64 编码的音频数据
    response_format: "json",
  };
  if (language) body.language = language;

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
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

// ─── STT: 通过多模态 LLM 降级转录 ────────────────────────────────
async function transcribeWithLlm(cfg, audioData, format, language) {
  var headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;

  var userContent = [
    { type: "text", text: "请将以下音频内容准确转录为文字。如果能识别语言，请在结果中注明。只输出 JSON: {\"transcript\":\"转录文字\",\"language\":\"检测到的语言\"}" },
    { type: "input_audio", input_audio: { data: audioData, format: format || "wav" } },
  ];

  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeoutMs) : null;

  try {
    var res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: userContent }],
        temperature: 0.1,
        max_tokens: 2048,
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();
    var text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    if (!text) return null;

    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      var parsed = JSON.parse(jsonMatch[0]);
      return {
        transcript: String(parsed.transcript || ""),
        language: String(parsed.language || language || ""),
        durationMs: null,
        confidence: 0.7,
      };
    }
    // 如果没有 JSON，整个输出作为转录文本
    return { transcript: text, language: language || "", durationMs: null, confidence: 0.5 };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── TTS: OpenAI 兼容 API ─────────────────────────────────────────
async function synthesizeWithTts(cfg, text, voice) {
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
        input: text,
        voice: voice || "alloy",
        response_format: "mp3",
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;

    // 响应是音频二进制，转为 base64
    var arrayBuf = await res.arrayBuffer();
    var bytes = new Uint8Array(arrayBuf);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    var b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");

    return {
      audioBase64: b64,
      durationMs: null, // TTS API 通常不返回时长
      confidence: 0.9,
    };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 解析音频数据 ─────────────────────────────────────────────────
async function resolveAudioData(audioUrl, audioBase64) {
  if (audioBase64) return audioBase64;
  if (audioUrl) {
    // data URI → 提取 base64
    if (audioUrl.startsWith("data:")) {
      var parts = audioUrl.split(",");
      return parts[1] || null;
    }
    // 远程 URL → fetch 下载
    try {
      var res = await fetch(audioUrl);
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

// ─── 主入口 ────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  var input = req && req.input ? req.input : {};
  var mode = String(input.mode || "transcribe").toLowerCase();

  // ── TTS 模式 ──
  if (mode === "tts") {
    var text = input.text ? String(input.text) : "";
    if (!text) {
      return { transcript: "", language: "", durationMs: 0, audioBase64: "", confidence: 0 };
    }
    var ttsCfg = resolveTtsConfig();
    if (!ttsCfg) {
      return {
        transcript: "",
        language: "",
        durationMs: 0,
        audioBase64: "",
        confidence: 0,
        _error: "未配置 SKILL_TTS_ENDPOINT，无法合成语音",
      };
    }
    var voice = input.voice ? String(input.voice) : "alloy";
    var ttsResult = await synthesizeWithTts(ttsCfg, text, voice);
    if (ttsResult) {
      return {
        transcript: text,
        language: "",
        durationMs: ttsResult.durationMs || 0,
        audioBase64: ttsResult.audioBase64 || "",
        confidence: ttsResult.confidence,
      };
    }
    return { transcript: text, language: "", durationMs: 0, audioBase64: "", confidence: 0 };
  }

  // ── STT (transcribe) 模式 ──
  var audioUrl = input.audioUrl ? String(input.audioUrl) : null;
  var audioBase64Input = input.audioBase64 ? String(input.audioBase64) : null;
  var format = String(input.format || "wav").toLowerCase();
  var language = input.language ? String(input.language) : "";

  var audioData = await resolveAudioData(audioUrl, audioBase64Input);
  if (!audioData) {
    return {
      transcript: "",
      language: "",
      durationMs: 0,
      audioBase64: "",
      confidence: 0,
      _error: "未提供有效音频数据",
    };
  }

  // ① 首选: 讯飞语音听写 (WebSocket)
  var iflytekCfg = resolveIflytekConfig();
  if (iflytekCfg) {
    var iflytekResult = await transcribeWithIflytek(iflytekCfg, audioData, format, language);
    if (iflytekResult) {
      return {
        transcript: iflytekResult.transcript,
        language: iflytekResult.language,
        durationMs: iflytekResult.durationMs || 0,
        audioBase64: "",
        confidence: iflytekResult.confidence,
      };
    }
  }

  // ② 降级: Whisper 兼容 API
  var sttCfg = resolveSttConfig();
  if (sttCfg) {
    var result = await transcribeWithWhisper(sttCfg, audioData, format, language);
    if (result) {
      return {
        transcript: result.transcript,
        language: result.language,
        durationMs: result.durationMs || 0,
        audioBase64: "",
        confidence: result.confidence,
      };
    }
  }

  // ③ 降级: 通过多模态 LLM 转录
  var llmCfg = resolveLlmFallbackConfig();
  if (llmCfg) {
    var llmResult = await transcribeWithLlm(llmCfg, audioData, format, language);
    if (llmResult) {
      return {
        transcript: llmResult.transcript,
        language: llmResult.language,
        durationMs: llmResult.durationMs || 0,
        audioBase64: "",
        confidence: llmResult.confidence,
      };
    }
  }

  // 完全无外部 API
  return {
    transcript: "",
    language: "",
    durationMs: 0,
    audioBase64: "",
    confidence: 0,
    _error: "未配置语音处理 API (SKILL_IFLYTEK_APP_ID / SKILL_STT_ENDPOINT / SKILL_LLM_ENDPOINT)，无法转录",
  };
};
