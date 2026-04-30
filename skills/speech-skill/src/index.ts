/**
 * speech-skill — 语音转录与合成
 *
 * 模式：
 *   transcribe: 音频 → 文字 (STT)
 *   tts: 文字 → 音频 (TTS)
 *
 * STT 降级链路：讯飞语音听写 → Whisper 兼容 API → 多模态 LLM
 * TTS：OpenAI-compatible /audio/speech
 */

import crypto from 'node:crypto';

interface SpeechInput {
  audioUrl?: string;
  audioBase64?: string;
  format?: string;
  language?: string;
  mode?: string; // 'transcribe' | 'tts'
  text?: string;
  voice?: string;
}

interface SpeechOutput {
  transcript?: string;
  language?: string;
  durationMs?: number;
  audioBase64?: string;
  confidence: number;
}

// ─── 配置 ────────────────────────────────────────────────────────

function resolveSttConfig() {
  return {
    iflytekAppId: process.env.SKILL_IFLYTEK_APP_ID?.trim(),
    iflytekApiKey: process.env.SKILL_IFLYTEK_API_KEY?.trim(),
    iflytekApiSecret: process.env.SKILL_IFLYTEK_API_SECRET?.trim(),
    iflytekTimeoutMs: parseInt(process.env.SKILL_IFLYTEK_TIMEOUT_MS || '30000', 10),
    whisperEndpoint: (process.env.SKILL_STT_ENDPOINT || process.env.SKILL_WHISPER_ENDPOINT || '').trim(),
    whisperApiKey: (process.env.SKILL_STT_API_KEY || process.env.SKILL_LLM_API_KEY || '').trim(),
    whisperModel: (process.env.SKILL_STT_MODEL || 'whisper-1').trim(),
    whisperTimeoutMs: parseInt(process.env.SKILL_STT_TIMEOUT_MS || '120000', 10),
    llmEndpoint: (process.env.SKILL_LLM_ENDPOINT || '').trim(),
    llmApiKey: (process.env.SKILL_LLM_API_KEY || '').trim(),
    llmModel: (process.env.SKILL_LLM_MODEL || 'gpt-4o-audio-preview').trim(),
    llmTimeoutMs: parseInt(process.env.SKILL_LLM_TIMEOUT_MS || '60000', 10),
  };
}

function resolveTtsConfig() {
  return {
    endpoint: (process.env.SKILL_TTS_ENDPOINT || '').trim(),
    apiKey: (process.env.SKILL_TTS_API_KEY || process.env.SKILL_LLM_API_KEY || '').trim(),
    model: (process.env.SKILL_TTS_MODEL || 'tts-1').trim(),
    timeoutMs: parseInt(process.env.SKILL_TTS_TIMEOUT_MS || '60000', 10),
  };
}

// ─── 讯飞 STT ────────────────────────────────────────────────────

function buildIflytekAuthUrl(apiKey: string, apiSecret: string): string {
  const host = 'iat-api.xfyun.cn';
  const path = '/v2/iat';
  const hostUrl = 'wss://iat-api.xfyun.cn/v2/iat';
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signatureSha = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureOrigin)
    .digest('base64');
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signatureSha}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return (
    hostUrl +
    '?authorization=' + encodeURIComponent(authorization) +
    '&date=' + encodeURIComponent(date) +
    '&host=' + encodeURIComponent(host)
  );
}

function mapIflytekLanguage(language?: string) {
  if (!language) return { language: 'zh_cn', accent: 'mandarin' };
  const l = language.toLowerCase();
  if (l.startsWith('en')) return { language: 'en_us', accent: '' };
  if (l.startsWith('ja')) return { language: 'ja_jp', accent: '' };
  if (l.startsWith('ko')) return { language: 'ko_kr', accent: '' };
  return { language: 'zh_cn', accent: 'mandarin' };
}

async function transcribeIflytek(
  audioBase64: string,
  format: string,
  language: string | undefined,
  cfg: ReturnType<typeof resolveSttConfig>,
): Promise<SpeechOutput> {
  // 讯飞 WebSocket 需要 Node.js WebSocket 支持
  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: null as any }));
  if (!WebSocket) throw new Error('讯飞 STT 需要 ws 模块');

  const url = buildIflytekAuthUrl(cfg.iflytekApiKey!, cfg.iflytekApiSecret!);
  const langCfg = mapIflytekLanguage(language);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let result = '';
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('讯飞 STT 超时'));
    }, cfg.iflytekTimeoutMs);

    ws.on('open', () => {
      const frameSize = 1280;
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const totalFrames = Math.ceil(audioBuffer.length / frameSize);

      for (let i = 0; i < totalFrames; i++) {
        const status = i === 0 ? 0 : i === totalFrames - 1 ? 2 : 1;
        const chunk = audioBuffer.subarray(i * frameSize, (i + 1) * frameSize);
        const frame: any = {
          data: { status, format: 'audio/L16;rate=16000', audio: chunk.toString('base64'), encoding: 'raw' },
        };
        if (i === 0) {
          frame.common = { app_id: cfg.iflytekAppId };
          frame.business = { language: langCfg.language, domain: 'iat', accent: langCfg.accent || 'mandarin', vad_eos: 3000, dwa: 'wpgs' };
        }
        ws.send(JSON.stringify(frame));
      }
    });

    ws.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.code !== 0) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`讯飞错误 ${msg.code}: ${msg.message}`));
          return;
        }
        const ws2 = msg.data?.result?.ws || [];
        for (const w of ws2) {
          for (const c of w.cw || []) {
            result += c.w || '';
          }
        }
        if (msg.data?.status === 2) {
          clearTimeout(timer);
          ws.close();
          resolve({ transcript: result, language: language || 'zh-CN', confidence: 0.9 });
        }
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Whisper STT ─────────────────────────────────────────────────

async function transcribeWhisper(
  audioBase64: string,
  format: string,
  language: string | undefined,
  cfg: ReturnType<typeof resolveSttConfig>,
): Promise<SpeechOutput> {
  const endpoint = cfg.whisperEndpoint.replace(/\/$/, '');
  const url = `${endpoint}/audio/transcriptions`;

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const boundary = '----SkillBoundary' + Date.now();
  const ext = format || 'wav';
  const filename = `audio.${ext}`;

  // 构建 multipart/form-data
  const parts: Buffer[] = [];
  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  addField('model', cfg.whisperModel);
  if (language) addField('language', language.split('-')[0]);

  // 文件字段
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/${ext}\r\n\r\n`
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${cfg.whisperApiKey}`,
    },
    body,
    signal: AbortSignal.timeout(cfg.whisperTimeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Whisper API 失败 (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  return {
    transcript: data.text || '',
    language: data.language || language || 'unknown',
    durationMs: data.duration ? Math.round(data.duration * 1000) : undefined,
    confidence: 0.85,
  };
}

// ─── LLM 多模态 STT (最终降级) ───────────────────────────────────

async function transcribeLlm(
  audioBase64: string,
  format: string,
  language: string | undefined,
  cfg: ReturnType<typeof resolveSttConfig>,
): Promise<SpeechOutput> {
  const endpoint = cfg.llmEndpoint.replace(/\/$/, '');
  const url = `${endpoint}/chat/completions`;

  const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format || 'wav'}`;
  const dataUrl = `data:${mimeType};base64,${audioBase64}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.llmApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请将这段音频转录为文字。只输出转录文本，不要添加任何说明。' },
            { type: 'input_audio', input_audio: { data: audioBase64, format: format || 'wav' } },
          ],
        },
      ],
      max_tokens: 4096,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(cfg.llmTimeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`LLM 多模态 STT 失败 (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  const transcript = data?.choices?.[0]?.message?.content || '';
  return { transcript, language: language || 'unknown', confidence: 0.7 };
}

// ─── TTS ─────────────────────────────────────────────────────────

async function synthesize(text: string, voice: string, cfg: ReturnType<typeof resolveTtsConfig>): Promise<SpeechOutput> {
  if (!cfg.endpoint) throw new Error('缺少 SKILL_TTS_ENDPOINT 配置');

  const endpoint = cfg.endpoint.replace(/\/$/, '');
  const url = `${endpoint}/audio/speech`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input: text,
      voice: voice || 'alloy',
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`TTS API 失败 (${resp.status}): ${errText}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuf).toString('base64');
  return { audioBase64, confidence: 0.95 };
}

// ─── 获取音频数据 ─────────────────────────────────────────────────

async function resolveAudioBase64(input: SpeechInput): Promise<string> {
  if (input.audioBase64) return input.audioBase64;
  if (input.audioUrl) {
    const resp = await fetch(input.audioUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`下载音频失败: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  }
  throw new Error('需要提供 audioUrl 或 audioBase64');
}

// ─── Skill 入口 ──────────────────────────────────────────────────

exports.execute = async function execute(req: { input?: SpeechInput }): Promise<SpeechOutput> {
  const input = req?.input || {};
  const mode = (input.mode || 'transcribe').toLowerCase();

  try {
    // ── TTS 模式 ──
    if (mode === 'tts' || mode === 'synthesize') {
      if (!input.text) throw new Error('TTS 模式需要提供 text 参数');
      const cfg = resolveTtsConfig();
      return await synthesize(input.text, input.voice || 'alloy', cfg);
    }

    // ── STT 模式 ──
    const audioBase64 = await resolveAudioBase64(input);
    const format = input.format || 'wav';
    const language = input.language;
    const cfg = resolveSttConfig();

    // 降级链路：讯飞 → Whisper → LLM
    const strategies: Array<{ name: string; fn: () => Promise<SpeechOutput>; available: boolean }> = [
      {
        name: '讯飞',
        fn: () => transcribeIflytek(audioBase64, format, language, cfg),
        available: !!(cfg.iflytekAppId && cfg.iflytekApiKey && cfg.iflytekApiSecret),
      },
      {
        name: 'Whisper',
        fn: () => transcribeWhisper(audioBase64, format, language, cfg),
        available: !!cfg.whisperEndpoint,
      },
      {
        name: 'LLM多模态',
        fn: () => transcribeLlm(audioBase64, format, language, cfg),
        available: !!cfg.llmEndpoint,
      },
    ];

    const available = strategies.filter(s => s.available);
    if (available.length === 0) {
      throw new Error('没有可用的 STT 配置（需要配置讯飞/Whisper/LLM 任一 API）');
    }

    for (let i = 0; i < available.length; i++) {
      try {
        const result = await available[i].fn();
        return result;
      } catch (err: any) {
        console.error(`[speech-skill] ${available[i].name} 失败:`, err.message);
        if (i === available.length - 1) throw err;
      }
    }

    return { transcript: '', confidence: 0 };
  } catch (err: any) {
    console.error('[speech-skill] 执行失败:', err.message);
    return { transcript: '', confidence: 0 };
  }
};
