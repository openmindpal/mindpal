/**
 * ocr-skill — 图像OCR文字提取
 *
 * 输入：imageUrl | imageBase64, mimeType, language, mode
 * 输出：text, language, wordCount, confidence, regions
 *
 * 降级链路：外部 OCR API → Vision LLM → 返回空结果
 */

interface OcrInput {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
  language?: string;
  mode?: string; // 'text' | 'structured'
}

interface OcrRegion {
  text: string;
  bbox?: [number, number, number, number];
  confidence?: number;
}

interface OcrOutput {
  text: string;
  language?: string;
  wordCount: number;
  confidence: number;
  regions?: OcrRegion[];
}

// ─── 配置 ────────────────────────────────────────────────────────

function resolveConfig() {
  return {
    ocrEndpoint: (process.env.SKILL_OCR_ENDPOINT || '').trim(),
    ocrApiKey: (process.env.SKILL_OCR_API_KEY || '').trim(),
    ocrTimeoutMs: parseInt(process.env.SKILL_OCR_TIMEOUT_MS || '60000', 10),
    llmEndpoint: (process.env.SKILL_LLM_ENDPOINT || '').trim(),
    llmApiKey: (process.env.SKILL_LLM_API_KEY || '').trim(),
    llmModel: (process.env.SKILL_VISION_MODEL || process.env.SKILL_LLM_MODEL || 'gpt-4o').trim(),
    llmTimeoutMs: parseInt(process.env.SKILL_VISION_TIMEOUT_MS || '60000', 10),
  };
}

// ─── 外部 OCR API (PaddleOCR 等) ──────────────────────────────────

async function ocrExternal(
  imageBase64: string,
  mimeType: string,
  language: string | undefined,
  mode: string,
  cfg: ReturnType<typeof resolveConfig>,
): Promise<OcrOutput> {
  const endpoint = cfg.ocrEndpoint.replace(/\/$/, '');
  const resp = await fetch(`${endpoint}/ocr`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: cfg.ocrApiKey ? `Bearer ${cfg.ocrApiKey}` : '',
    },
    body: JSON.stringify({
      image: imageBase64,
      mimeType,
      language: language || 'auto',
      mode,
    }),
    signal: AbortSignal.timeout(cfg.ocrTimeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OCR API 失败 (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  const text = data.text || data.result || '';
  const regions: OcrRegion[] = Array.isArray(data.regions) ? data.regions : [];

  return {
    text,
    language: data.language || language,
    wordCount: text.length,
    confidence: data.confidence ?? 0.9,
    regions: mode === 'structured' ? regions : undefined,
  };
}

// ─── Vision LLM OCR ──────────────────────────────────────────────

async function ocrVisionLlm(
  imageBase64: string,
  mimeType: string,
  language: string | undefined,
  mode: string,
  cfg: ReturnType<typeof resolveConfig>,
): Promise<OcrOutput> {
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  const systemPrompt = mode === 'structured'
    ? '你是一个OCR文字识别助手。请识别图片中的所有文字内容，并按区域返回。以JSON格式回答：{"text":"全部文字","regions":[{"text":"区域文字","confidence":0.95}]}'
    : '请仔细识别图片中的所有文字内容。按照原始排版输出所有识别到的文字。如果图片中没有文字，返回空字符串。只输出识别到的文字，不要添加任何额外说明。';

  const endpoint = cfg.llmEndpoint.replace(/\/$/, '');
  const resp = await fetch(`${endpoint}/chat/completions`, {
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
            { type: 'text', text: systemPrompt },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
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
    throw new Error(`Vision LLM OCR 失败 (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  const content: string = data?.choices?.[0]?.message?.content || '';

  // structured 模式尝试解析 JSON
  if (mode === 'structured') {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const text = parsed.text || content;
        return {
          text,
          language: language || detectLanguage(text),
          wordCount: text.length,
          confidence: 0.8,
          regions: Array.isArray(parsed.regions) ? parsed.regions : undefined,
        };
      }
    } catch {
      // 解析失败 fallthrough
    }
  }

  return {
    text: content,
    language: language || detectLanguage(content),
    wordCount: content.length,
    confidence: 0.75,
    regions: undefined,
  };
}

// ─── 工具函数 ────────────────────────────────────────────────────

function detectLanguage(text: string): string {
  if (!text) return 'unknown';
  // 简单启发式检测
  const cjk = text.match(/[\u4e00-\u9fff]/g);
  const latin = text.match(/[a-zA-Z]/g);
  if (cjk && cjk.length > (latin?.length || 0)) return 'zh-CN';
  if (latin && latin.length > (cjk?.length || 0)) return 'en';
  return 'unknown';
}

async function resolveImageBase64(input: OcrInput): Promise<string> {
  if (input.imageBase64) return input.imageBase64;
  if (input.imageUrl) {
    // data: URL 直接提取
    if (input.imageUrl.startsWith('data:')) {
      const match = input.imageUrl.match(/base64,(.+)/);
      if (match) return match[1];
    }
    const resp = await fetch(input.imageUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`下载图片失败: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  }
  throw new Error('需要提供 imageUrl 或 imageBase64');
}

// ─── Skill 入口 ──────────────────────────────────────────────────

exports.execute = async function execute(req: { input?: OcrInput }): Promise<OcrOutput> {
  const input = req?.input || {};
  const mimeType = input.mimeType || 'image/png';
  const mode = input.mode || 'text';
  const cfg = resolveConfig();

  if (!input.imageUrl && !input.imageBase64) {
    throw new Error('需要提供 imageUrl 或 imageBase64');
  }

  try {
    const imageBase64 = await resolveImageBase64(input);

    // 降级链路：外部 OCR API → Vision LLM → 空结果
    const strategies: Array<{ name: string; fn: () => Promise<OcrOutput>; available: boolean }> = [
      {
        name: '外部OCR',
        fn: () => ocrExternal(imageBase64, mimeType, input.language, mode, cfg),
        available: !!cfg.ocrEndpoint,
      },
      {
        name: 'Vision LLM',
        fn: () => ocrVisionLlm(imageBase64, mimeType, input.language, mode, cfg),
        available: !!(cfg.llmEndpoint && cfg.llmApiKey),
      },
    ];

    const available = strategies.filter(s => s.available);
    if (available.length === 0) {
      throw new Error('没有可用的 OCR 配置（需要配置 SKILL_OCR_ENDPOINT 或 SKILL_LLM_ENDPOINT）');
    }

    for (let i = 0; i < available.length; i++) {
      try {
        return await available[i].fn();
      } catch (err: any) {
        console.error(`[ocr-skill] ${available[i].name} 失败:`, err.message);
        if (i === available.length - 1) throw err;
      }
    }

    return { text: '', wordCount: 0, confidence: 0 };
  } catch (err: any) {
    console.error('[ocr-skill] 执行失败:', err.message);
    return { text: '', wordCount: 0, confidence: 0 };
  }
};
