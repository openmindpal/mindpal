/**
 * vision-skill — 图像视觉分析
 *
 * 输入：imageBase64 | imageUrl, mimeType, question, detail
 * 输出：description, answer, tags, confidence
 *
 * 降级链路：GPT-4V → 通用 Vision 模型 → 返回错误
 */

interface VisionInput {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
  question?: string;
  detail?: string;
}

interface VisionOutput {
  description: string;
  answer?: string;
  tags: string[];
  confidence: number;
}

// ─── 配置 ────────────────────────────────────────────────────────

function resolveConfig() {
  return {
    endpoint: (process.env.SKILL_LLM_ENDPOINT || '').trim(),
    apiKey: (process.env.SKILL_LLM_API_KEY || '').trim(),
    model: (process.env.SKILL_VISION_MODEL || process.env.SKILL_LLM_MODEL || 'gpt-4o').trim(),
    fallbackModel: (process.env.SKILL_VISION_FALLBACK_MODEL || 'gpt-4o-mini').trim(),
    timeoutMs: parseInt(process.env.SKILL_VISION_TIMEOUT_MS || '60000', 10),
  };
}

// ─── 核心调用 ─────────────────────────────────────────────────────

async function callVisionModel(
  input: VisionInput,
  model: string,
  cfg: ReturnType<typeof resolveConfig>,
): Promise<VisionOutput> {
  const mimeType = input.mimeType || 'image/png';
  const detail = input.detail || 'auto';

  // 构建 image_url content part
  let imageUrlStr: string;
  if (input.imageBase64) {
    imageUrlStr = `data:${mimeType};base64,${input.imageBase64}`;
  } else if (input.imageUrl) {
    imageUrlStr = input.imageUrl;
  } else {
    throw new Error('需要提供 imageUrl 或 imageBase64');
  }

  const userPrompt = input.question
    ? `请分析这张图片并回答以下问题：${input.question}\n同时给出图片的简要描述和关键标签。`
    : '请详细描述这张图片的内容，提取关键标签，并给出你对描述的置信度（0-1）。以JSON格式回答：{"description":"...","tags":["..."],"confidence":0.9}';

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: imageUrlStr, detail } },
      ],
    },
  ];

  const endpoint = cfg.endpoint.replace(/\/$/, '');
  const url = `${endpoint}/chat/completions`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Vision API 调用失败 (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  const content: string = data?.choices?.[0]?.message?.content || '';

  return parseVisionResponse(content, input.question);
}

function parseVisionResponse(content: string, question?: string): VisionOutput {
  // 尝试解析 JSON 格式的回复
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        description: parsed.description || content,
        answer: question ? (parsed.answer || parsed.description || content) : undefined,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
      };
    }
  } catch {
    // 解析失败，使用纯文本
  }

  return {
    description: content,
    answer: question ? content : undefined,
    tags: [],
    confidence: 0.7,
  };
}

// ─── Skill 入口 ──────────────────────────────────────────────────

exports.execute = async function execute(req: { input?: VisionInput }): Promise<VisionOutput> {
  const input = req?.input || {};
  const cfg = resolveConfig();

  if (!cfg.endpoint || !cfg.apiKey) {
    throw new Error('缺少 SKILL_LLM_ENDPOINT 或 SKILL_LLM_API_KEY 环境变量配置');
  }

  if (!input.imageUrl && !input.imageBase64) {
    throw new Error('需要提供 imageUrl 或 imageBase64');
  }

  // 降级链路：主模型 → fallback 模型
  const models = [cfg.model, cfg.fallbackModel].filter(Boolean);

  for (let i = 0; i < models.length; i++) {
    try {
      return await callVisionModel(input, models[i], cfg);
    } catch (err: any) {
      console.error(`[vision-skill] 模型 ${models[i]} 调用失败:`, err.message);
      if (i === models.length - 1) {
        // 所有模型均失败
        return {
          description: '',
          answer: input.question ? '' : undefined,
          tags: [],
          confidence: 0,
        };
      }
    }
  }

  // 不应到达
  return { description: '', tags: [], confidence: 0 };
};
