/**
 * audioService — STT / TTS 统一封装
 *
 * STT 三级降级：讯飞 WebSocket → Whisper HTTP → 多模态 LLM
 * TTS：OpenAI-compatible /audio/speech
 */
import crypto from "node:crypto";

// ─── 配置读取 ────────────────────────────────────────────────────

function resolveSttConfig() {
  return {
    iflytekAppId: process.env.SKILL_IFLYTEK_APP_ID?.trim(),
    iflytekApiKey: process.env.SKILL_IFLYTEK_API_KEY?.trim(),
    iflytekApiSecret: process.env.SKILL_IFLYTEK_API_SECRET?.trim(),
    iflytekTimeoutMs: parseInt(process.env.SKILL_IFLYTEK_TIMEOUT_MS || "30000", 10),
    whisperEndpoint: (process.env.SKILL_STT_ENDPOINT || process.env.SKILL_WHISPER_ENDPOINT || "").trim(),
    whisperApiKey: (process.env.SKILL_STT_API_KEY || process.env.SKILL_LLM_API_KEY || "").trim(),
    whisperModel: (process.env.SKILL_STT_MODEL || "whisper-1").trim(),
    whisperTimeoutMs: parseInt(process.env.SKILL_STT_TIMEOUT_MS || "120000", 10),
    llmEndpoint: (process.env.SKILL_LLM_ENDPOINT || "").trim(),
    llmApiKey: (process.env.SKILL_LLM_API_KEY || "").trim(),
    llmModel: (process.env.SKILL_LLM_MODEL || "gpt-4o-audio-preview").trim(),
    llmTimeoutMs: parseInt(process.env.SKILL_LLM_TIMEOUT_MS || "60000", 10),
  };
}

function resolveTtsConfig() {
  return {
    endpoint: (process.env.SKILL_TTS_ENDPOINT || "").trim(),
    apiKey: (process.env.SKILL_TTS_API_KEY || process.env.SKILL_LLM_API_KEY || "").trim(),
    model: (process.env.SKILL_TTS_MODEL || "tts-1").trim(),
    timeoutMs: parseInt(process.env.SKILL_TTS_TIMEOUT_MS || "60000", 10),
  };
}

// ─── 讯飞辅助 ──────────────────────────────────────────────────

function buildIflytekAuthUrl(cfg: {
  apiKey: string; apiSecret: string; host: string; path: string; hostUrl: string;
}): string {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${cfg.host}\ndate: ${date}\nGET ${cfg.path} HTTP/1.1`;
  const signatureSha = crypto
    .createHmac("sha256", cfg.apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin =
    `api_key="${cfg.apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signatureSha}"`;
  const authorization = Buffer.from(authorizationOrigin).toString("base64");
  return (
    cfg.hostUrl +
    "?authorization=" + encodeURIComponent(authorization) +
    "&date=" + encodeURIComponent(date) +
    "&host=" + encodeURIComponent(cfg.host)
  );
}

function mapIflytekEncoding(format?: string) {
  switch ((format || "").toLowerCase()) {
    case "mp3":  return { encoding: "lame", format: "audio/L16;rate=16000" };
    case "wav":  return { encoding: "raw",  format: "audio/L16;rate=16000" };
    case "pcm":  return { encoding: "raw",  format: "audio/L16;rate=16000" };
    default:     return { encoding: "raw",  format: "audio/L16;rate=16000" };
  }
}

function mapIflytekLanguage(language?: string) {
  if (!language) return { language: "zh_cn", accent: "mandarin" };
  const l = language.toLowerCase();
  if (l.startsWith("en")) return { language: "en_us", accent: "" };
  if (l.startsWith("ja")) return { language: "ja_jp", accent: "" };
  if (l.startsWith("ko")) return { language: "ko_kr", accent: "" };
  if (l.startsWith("zh")) {
    if (l.includes("yue") || l.includes("cantonese"))
      return { language: "zh_cn", accent: "cantonese" };
    return { language: "zh_cn", accent: "mandarin" };
  }
  return { language: "zh_cn", accent: "mandarin" };
}

// ─── 讯飞 WebSocket STT ────────────────────────────────────────

async function transcribeIflytek(
  cfg: ReturnType<typeof resolveSttConfig>,
  audioBase64: string,
  format?: string,
  language?: string,
): Promise<{ transcript: string; language?: string; confidence: number; durationMs?: number } | null> {
  const { iflytekAppId, iflytekApiKey, iflytekApiSecret, iflytekTimeoutMs } = cfg;
  if (!iflytekAppId || !iflytekApiKey || !iflytekApiSecret) return null;

  let WS: any;
  try { WS = require("ws"); } catch { /* ignore */ }
  if (!WS) return null;

  const iflytekCfg = {
    appId: iflytekAppId,
    apiKey: iflytekApiKey,
    apiSecret: iflytekApiSecret,
    host: "iat-api.xfyun.cn",
    path: "/v2/iat",
    hostUrl: "wss://iat-api.xfyun.cn/v2/iat",
  };

  const url = buildIflytekAuthUrl(iflytekCfg);
  const enc = mapIflytekEncoding(format);
  const lang = mapIflytekLanguage(language);

  return new Promise((resolve) => {
    let ws: any;
    try { ws = new WS(url); } catch { resolve(null); return; }

    let resultText = "";
    let resolved = false;

    function done(val: any) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(val);
    }

    const timer = setTimeout(() => done(null), iflytekTimeoutMs);

    const audioBuffer = Buffer.from(audioBase64, "base64");
    const frameSize = 1280;

    ws.on("open", () => {
      const totalFrames = Math.max(1, Math.ceil(audioBuffer.length / frameSize));
      for (let i = 0; i < totalFrames; i++) {
        const start = i * frameSize;
        const end = Math.min(start + frameSize, audioBuffer.length);
        const chunk = audioBuffer.slice(start, end);
        const status = totalFrames === 1 ? 2 : (i === 0 ? 0 : (i === totalFrames - 1 ? 2 : 1));

        const frame: any = {
          data: { status, format: enc.format, encoding: enc.encoding, audio: chunk.toString("base64") },
        };
        if (i === 0) {
          frame.common = { app_id: iflytekCfg.appId };
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
    });

    ws.on("message", (raw: any) => {
      try {
        const resp = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (resp.code !== 0) { done(null); return; }
        if (resp.data?.result) {
          for (const w of resp.data.result.ws || []) {
            for (const c of w.cw || []) {
              resultText += c.w || "";
            }
          }
        }
        if (resp.data?.status === 2) {
          const detectedLang = lang.language === "zh_cn" ? "zh-CN"
            : lang.language === "en_us" ? "en-US"
            : lang.language === "ja_jp" ? "ja-JP"
            : lang.language === "ko_kr" ? "ko-KR"
            : (language || "");
          done({ transcript: resultText.trim(), language: detectedLang, confidence: 0.92, durationMs: undefined });
        }
      } catch { /* ignore parse error, wait next frame */ }
    });

    ws.on("error", () => done(null));
    ws.on("close", () => {
      done(
        resultText
          ? { transcript: resultText.trim(), language: language || "", confidence: 0.85, durationMs: undefined }
          : null,
      );
    });
  });
}

// ─── 流式 STT 会话（复用讯飞 WebSocket） ─────────────────────────

export interface StreamingSTTCallbacks {
  onInterim?: (text: string) => void;
  onFinal?: (text: string, confidence: number) => void;
  onError?: (error: string) => void;
}

export interface StreamingSTTSession {
  feedAudio: (pcmBase64: string) => void;
  finish: () => Promise<{ transcript: string; confidence: number }>;
  abort: () => void;
}

/**
 * 创建流式 STT 会话
 * 复用讯飞 WebSocket API，改造为持久连接模式。
 * 客户端持续发送 PCM base64 音频块（16kHz/16bit/mono），
 * 服务端实时返回中间/最终转录结果。
 * 若讯飞配置不可用，返回 null（由调用方回退到 HTTP 批量模式）。
 */
export function createStreamingSTTSession(
  callbacks?: StreamingSTTCallbacks,
  language?: string,
): StreamingSTTSession | null {
  const cfg = resolveSttConfig();
  const { iflytekAppId, iflytekApiKey, iflytekApiSecret, iflytekTimeoutMs } = cfg;
  if (!iflytekAppId || !iflytekApiKey || !iflytekApiSecret) return null;

  let WS: any;
  try { WS = require("ws"); } catch { /* ignore */ }
  if (!WS) return null;

  const iflytekCfg = {
    appId: iflytekAppId,
    apiKey: iflytekApiKey,
    apiSecret: iflytekApiSecret,
    host: "iat-api.xfyun.cn",
    path: "/v2/iat",
    hostUrl: "wss://iat-api.xfyun.cn/v2/iat",
  };

  const url = buildIflytekAuthUrl(iflytekCfg);
  const lang = mapIflytekLanguage(language);

  let ws: any;
  try { ws = new WS(url); } catch { return null; }

  let resultText = "";
  let frameIndex = 0;
  let finished = false;
  let aborted = false;
  let finishResolve: ((v: { transcript: string; confidence: number }) => void) | null = null;

  const timer = setTimeout(() => {
    if (!finished && !aborted) {
      callbacks?.onError?.("streaming STT timeout");
      abort();
    }
  }, iflytekTimeoutMs);

  // 讯飞要求首帧携带 common + business，后续帧仅携带 data
  let wsReady = false;
  const pendingChunks: string[] = [];

  ws.on("open", () => {
    wsReady = true;
    // 发送首帧（仅 common+business，无音频数据）以初始化会话
    const firstFrame: any = {
      common: { app_id: iflytekCfg.appId },
      business: {
        language: lang.language,
        domain: "iat",
        accent: lang.accent || "mandarin",
        vad_eos: 3000,
        dwa: "wpgs",
        ptt: 1,
      },
      data: {
        status: 0,
        format: "audio/L16;rate=16000",
        encoding: "raw",
        audio: "",
      },
    };
    ws.send(JSON.stringify(firstFrame));
    frameIndex = 1;

    // 发送缓冲中的音频块
    for (const chunk of pendingChunks) {
      sendAudioFrame(chunk, false);
    }
    pendingChunks.length = 0;
  });

  ws.on("message", (raw: any) => {
    try {
      const resp = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (resp.code !== 0) {
        callbacks?.onError?.(`iflytek error: ${resp.code} ${resp.message ?? ""}`);
        return;
      }
      if (resp.data?.result) {
        // wpgs 模式下，pgs="apd" 表示追加，pgs="rpl" 表示替换
        const pgs = resp.data.result.pgs;
        let segText = "";
        for (const w of resp.data.result.ws || []) {
          for (const c of w.cw || []) {
            segText += c.w || "";
          }
        }
        if (pgs === "rpl") {
          // 替换模式：用最新 segment 更新（简化处理）
          resultText = segText;
        } else {
          resultText += segText;
        }
        callbacks?.onInterim?.(resultText);
      }
      if (resp.data?.status === 2) {
        // 最终结果
        finished = true;
        clearTimeout(timer);
        const confidence = 0.92;
        callbacks?.onFinal?.(resultText.trim(), confidence);
        finishResolve?.({ transcript: resultText.trim(), confidence });
        try { ws.close(); } catch { /* ignore */ }
      }
    } catch { /* ignore parse error */ }
  });

  ws.on("error", () => {
    if (!finished && !aborted) {
      callbacks?.onError?.("iflytek ws error");
    }
  });

  ws.on("close", () => {
    clearTimeout(timer);
    if (!finished && !aborted) {
      // 连接意外关闭，返回已有结果
      const confidence = resultText ? 0.85 : 0;
      callbacks?.onFinal?.(resultText.trim(), confidence);
      finishResolve?.({ transcript: resultText.trim(), confidence });
      finished = true;
    }
  });

  function sendAudioFrame(pcmBase64: string, isLast: boolean): void {
    if (aborted || ws.readyState !== 1 /* OPEN */) return;
    const frame: any = {
      data: {
        status: isLast ? 2 : 1,
        format: "audio/L16;rate=16000",
        encoding: "raw",
        audio: pcmBase64,
      },
    };
    ws.send(JSON.stringify(frame));
    frameIndex++;
  }

  function feedAudio(pcmBase64: string): void {
    if (finished || aborted) return;
    if (!wsReady) {
      pendingChunks.push(pcmBase64);
      return;
    }
    sendAudioFrame(pcmBase64, false);
  }

  async function finish(): Promise<{ transcript: string; confidence: number }> {
    if (finished) return { transcript: resultText.trim(), confidence: resultText ? 0.92 : 0 };
    if (aborted) return { transcript: "", confidence: 0 };

    // 发送结束帧
    sendAudioFrame("", true);

    return new Promise((resolve) => {
      finishResolve = resolve;
      // 超时兜底
      setTimeout(() => {
        if (!finished) {
          finished = true;
          resolve({ transcript: resultText.trim(), confidence: resultText ? 0.85 : 0 });
          try { ws.close(); } catch { /* ignore */ }
        }
      }, 10000);
    });
  }

  function abort(): void {
    if (aborted) return;
    aborted = true;
    clearTimeout(timer);
    finishResolve?.({ transcript: resultText.trim(), confidence: resultText ? 0.7 : 0 });
    try { ws.close(); } catch { /* ignore */ }
  }

  return { feedAudio, finish, abort };
}

// ─── Whisper HTTP STT ──────────────────────────────────────────

async function transcribeWhisper(
  cfg: ReturnType<typeof resolveSttConfig>,
  audioBase64: string,
  format?: string,
  language?: string,
): Promise<{ transcript: string; language?: string; confidence: number; durationMs?: number } | null> {
  if (!cfg.whisperEndpoint) return null;

  const audioBuffer = Buffer.from(audioBase64, "base64");
  const mimeType = format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : "audio/webm";
  const ext = format || "webm";

  const blob = new Blob([audioBuffer], { type: mimeType });
  const formData = new FormData();
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", cfg.whisperModel);
  formData.append("response_format", "json");
  if (language) formData.append("language", language);

  const url = cfg.whisperEndpoint.endsWith("/")
    ? cfg.whisperEndpoint + "audio/transcriptions"
    : cfg.whisperEndpoint + "/audio/transcriptions";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.whisperTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: cfg.whisperApiKey ? { Authorization: `Bearer ${cfg.whisperApiKey}` } : {},
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json: any = await res.json();
    return {
      transcript: json.text ?? "",
      language: json.language ?? language,
      confidence: 0.9,
      durationMs: json.duration ? Math.round(json.duration * 1000) : undefined,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── 多模态 LLM 降级 STT ──────────────────────────────────────

async function transcribeLlm(
  cfg: ReturnType<typeof resolveSttConfig>,
  audioBase64: string,
  format?: string,
  _language?: string,
): Promise<{ transcript: string; language?: string; confidence: number; durationMs?: number } | null> {
  if (!cfg.llmEndpoint) return null;

  const shortFormat = format === "mp3" ? "mp3" : format === "wav" ? "wav" : "webm";

  const url = cfg.llmEndpoint.replace(/\/+$/, "") + "/chat/completions";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.llmTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.llmApiKey ? { Authorization: `Bearer ${cfg.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "请将以下音频转录为文字，只输出转录结果，不要任何额外说明。" },
              { type: "input_audio", input_audio: { data: audioBase64, format: shortFormat } }
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json: any = await res.json();
    const text = json.choices?.[0]?.message?.content ?? "";
    return { transcript: text.trim(), confidence: 0.7, durationMs: undefined };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── TTS 实现 ──────────────────────────────────────────────────

async function ttsInternal(
  text: string,
  voice: string,
  model?: string,
): Promise<{ audioBase64: string; format: string } | null> {
  const cfg = resolveTtsConfig();
  if (!cfg.endpoint) return null;

  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  // 如果 endpoint 已包含完整路径（如 /audio/speech），直接使用；否则拼接
  const url = /\/audio\/speech/i.test(endpoint) ? endpoint : endpoint + "/audio/speech";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || cfg.model,
        input: text.slice(0, 4000),
        voice,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const arrayBuf = await res.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuf).toString("base64");
    return { audioBase64, format: "mp3" };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── 公共接口 ──────────────────────────────────────────────────

export async function transcribeAudio(input: {
  audioBase64: string;
  format?: string;
  language?: string;
  sampleRate?: number;
}): Promise<{ transcript: string; language?: string; confidence: number; durationMs?: number }> {
  const cfg = resolveSttConfig();

  // 三级降级：讯飞 → Whisper → LLM
  const result =
    (await transcribeIflytek(cfg, input.audioBase64, input.format, input.language)) ??
    (await transcribeWhisper(cfg, input.audioBase64, input.format, input.language)) ??
    (await transcribeLlm(cfg, input.audioBase64, input.format, input.language));

  if (result) return result;
  return { transcript: "", confidence: 0 };
}

export async function synthesizeSpeech(input: {
  text: string;
  voice?: string;
  model?: string;
}): Promise<{ audioBase64: string; format: string }> {
  const result = await ttsInternal(input.text, input.voice || "alloy", input.model);
  if (result) return result;
  return { audioBase64: "", format: "mp3" };
}

export function getAudioCapabilities(): { stt: { ready: boolean; streamingReady: boolean }; tts: { ready: boolean } } {
  const stt = resolveSttConfig();
  const tts = resolveTtsConfig();

  const iflytekReady = Boolean(stt.iflytekAppId && stt.iflytekApiKey && stt.iflytekApiSecret);
  const whisperReady = Boolean(stt.whisperEndpoint);
  const llmReady = Boolean(stt.llmEndpoint);
  const sttReady = iflytekReady || whisperReady || llmReady;

  // 流式 STT 仅讯飞 WS 支持
  let wsAvailable = false;
  try { require("ws"); wsAvailable = true; } catch { /* ignore */ }
  const streamingReady = iflytekReady && wsAvailable;

  const ttsReady = Boolean(tts.endpoint);

  return { stt: { ready: sttReady, streamingReady }, tts: { ready: ttsReady } };
}
