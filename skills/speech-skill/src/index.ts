/**
 * speech-skill — 语音合成 (TTS)
 *
 * 模式：
 *   tts: 文字 → 音频 (TTS)
 *
 * STT 已迁移至流式端点 /v1/audio/stream-stt
 * TTS：OpenAI-compatible /audio/speech
 */

interface SpeechInput {
  mode?: string; // 'tts'
  text?: string;
  voice?: string;
}

interface SpeechOutput {
  audioBase64?: string;
  confidence: number;
  error?: string;
}

// ─── 配置 ────────────────────────────────────────────────────────

function resolveTtsConfig() {
  return {
    endpoint: (process.env.SKILL_TTS_ENDPOINT || '').trim(),
    apiKey: (process.env.SKILL_TTS_API_KEY || process.env.SKILL_LLM_API_KEY || '').trim(),
    model: (process.env.SKILL_TTS_MODEL || 'tts-1').trim(),
    timeoutMs: parseInt(process.env.SKILL_TTS_TIMEOUT_MS || '60000', 10),
  };
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

// ─── Skill 入口 ──────────────────────────────────────────────────

exports.execute = async function execute(req: { input?: SpeechInput }): Promise<SpeechOutput> {
  const input = req?.input || {};
  const mode = (input.mode || 'tts').toLowerCase();

  try {
    // ── TTS 模式 ──
    if (mode === 'tts' || mode === 'synthesize') {
      if (!input.text) throw new Error('TTS 模式需要提供 text 参数');
      const cfg = resolveTtsConfig();
      return await synthesize(input.text, input.voice || 'alloy', cfg);
    }

    // ── STT 已迁移 ──
    if (mode === 'transcribe' || mode === 'stt') {
      return {
        confidence: 0,
        error: 'STT 已迁移至流式端点，请使用 /v1/audio/stream-stt',
      };
    }

    throw new Error(`未知模式: ${mode}`);
  } catch (err: any) {
    console.error('[speech-skill] 执行失败:', err.message);
    return { confidence: 0, error: err.message };
  }
};
