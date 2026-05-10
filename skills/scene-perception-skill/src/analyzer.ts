/**
 * Universal Scene Analyzer
 * 
 * Calls VLM (Vision-Language Model) APIs to understand any scene.
 * Supports multiple VLM backends via OpenAI-compatible API format.
 * 
 * Configuration priority:
 * 1. Runtime config passed via execute request (platform model gateway)
 * 2. Standard SKILL_LLM_* environment variables (platform runner injection)
 * 3. Legacy PERCEPTION_VLM_* variables (backward compatibility only)
 */

import {
  SceneAnalysis,
  IdentifyResult,
  SpatialQueryResult,
  StateResult,
  AffordanceResult,
  VlmConfig,
} from './types';
import {
  SCENE_ANALYSIS_PROMPT,
  IDENTIFY_PROMPT,
  SPATIAL_QUERY_PROMPT,
  STATE_QUERY_PROMPT,
  AFFORDANCE_PROMPT,
  buildPrompt,
} from './prompts';

/** 
 * Load VLM configuration
 * 
 * Priority:
 * 1. Runtime config passed via execute request (platform model gateway)
 * 2. Standard SKILL_LLM_* environment variables (platform runner injection)
 * 3. Legacy PERCEPTION_VLM_* variables (backward compatibility only)
 */
export function loadConfig(runtimeConfig?: Partial<VlmConfig>): VlmConfig {
  // Priority 1: Runtime config from platform
  if (runtimeConfig?.endpoint && runtimeConfig?.apiKey) {
    return {
      endpoint: runtimeConfig.endpoint.replace(/\/$/, ''),
      apiKey: runtimeConfig.apiKey,
      model: runtimeConfig.model || 'gpt-4o',
      timeoutMs: runtimeConfig.timeoutMs || 25000,
      maxTokens: runtimeConfig.maxTokens || 4096,
    };
  }

  // Priority 2: Standard platform Skill LLM variables
  const skillEndpoint = (
    process.env.SKILL_LLM_ENDPOINT ||
    process.env.SKILL_VISION_ENDPOINT ||
    process.env.PERCEPTION_VLM_ENDPOINT ||  // Legacy fallback
    'https://api.openai.com/v1'
  ).trim().replace(/\/$/, '');

  const skillApiKey = (
    process.env.SKILL_LLM_API_KEY ||
    process.env.SKILL_VISION_API_KEY ||
    process.env.PERCEPTION_VLM_API_KEY ||  // Legacy fallback
    ''
  ).trim();

  const skillModel = (
    process.env.SKILL_VISION_MODEL ||
    process.env.SKILL_LLM_MODEL ||
    process.env.PERCEPTION_VLM_MODEL ||  // Legacy fallback
    'gpt-4o'
  ).trim();

  const timeoutMs = Math.max(5000,
    Number(process.env.SKILL_LLM_TIMEOUT_MS) ||
    Number(process.env.PERCEPTION_VLM_TIMEOUT) ||
    25000
  );

  const maxTokens = Math.max(256,
    Number(process.env.PERCEPTION_VLM_MAX_TOKENS) || 4096
  );

  return { endpoint: skillEndpoint, apiKey: skillApiKey, model: skillModel, timeoutMs, maxTokens };
}

/** Call VLM API with image + text prompt */
async function callVlm(config: VlmConfig, imageBase64: string, prompt: string): Promise<string> {
  if (!config.apiKey) {
    throw new Error('VLM API key not configured. Set via platform model management or SKILL_LLM_API_KEY environment variable.');
  }

  const url = `${config.endpoint}/chat/completions`;

  const body = {
    model: config.model,
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: prompt },
          {
            type: 'image_url' as const,
            image_url: {
              url: imageBase64.startsWith('data:')
                ? imageBase64
                : `data:image/png;base64,${imageBase64}`,
              detail: 'high' as const,
            },
          },
        ],
      },
    ],
    max_tokens: config.maxTokens,
    temperature: 0.1, // Low temperature for factual analysis
    response_format: { type: 'json_object' as const },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      throw new Error(`VLM API error ${response.status}: ${errText}`);
    }

    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('VLM returned empty response');
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/** Parse JSON from VLM response (handles markdown code blocks) */
function parseVlmJson<T>(raw: string): T {
  let cleaned = raw.trim();
  // Remove markdown code block wrapper if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(cleaned) as T;
}

export class SceneAnalyzer {
  private config: VlmConfig;

  constructor(runtimeConfig?: Partial<VlmConfig>) {
    this.config = loadConfig(runtimeConfig);
  }

  /** Full scene analysis — identifies all objects, relations, hazards */
  async analyze(imageBase64: string, context?: string): Promise<SceneAnalysis> {
    let prompt = SCENE_ANALYSIS_PROMPT;
    if (context) {
      prompt += `\n\nAdditional context: ${context}`;
    }
    const raw = await callVlm(this.config, imageBase64, prompt);
    return parseVlmJson<SceneAnalysis>(raw);
  }

  /** Identify a specific object in the scene */
  async identify(imageBase64: string, target: string): Promise<IdentifyResult> {
    const prompt = buildPrompt(IDENTIFY_PROMPT, { target });
    const raw = await callVlm(this.config, imageBase64, prompt);
    return parseVlmJson<IdentifyResult>(raw);
  }

  /** Query spatial relationships */
  async querySpatial(imageBase64: string, question: string): Promise<SpatialQueryResult> {
    const prompt = buildPrompt(SPATIAL_QUERY_PROMPT, { question });
    const raw = await callVlm(this.config, imageBase64, prompt);
    return parseVlmJson<SpatialQueryResult>(raw);
  }

  /** Query object state */
  async queryState(imageBase64: string, object: string): Promise<StateResult> {
    const prompt = buildPrompt(STATE_QUERY_PROMPT, { object });
    const raw = await callVlm(this.config, imageBase64, prompt);
    return parseVlmJson<StateResult>(raw);
  }

  /** Analyze object affordances (what can be done with it) */
  async queryAffordance(imageBase64: string, object: string): Promise<AffordanceResult> {
    const prompt = buildPrompt(AFFORDANCE_PROMPT, { object });
    const raw = await callVlm(this.config, imageBase64, prompt);
    return parseVlmJson<AffordanceResult>(raw);
  }
}
