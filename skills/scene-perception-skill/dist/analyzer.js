"use strict";
/**
 * Universal Scene Analyzer
 *
 * Calls VLM (Vision-Language Model) APIs to understand any scene.
 * Supports multiple VLM backends via OpenAI-compatible API format.
 *
 * Configuration (environment variables):
 * - PERCEPTION_VLM_ENDPOINT: API base URL (default: https://api.openai.com/v1)
 * - PERCEPTION_VLM_API_KEY: API key
 * - PERCEPTION_VLM_MODEL: Model name (default: gpt-4o)
 * - PERCEPTION_VLM_TIMEOUT: Request timeout in ms (default: 25000)
 * - PERCEPTION_VLM_MAX_TOKENS: Max response tokens (default: 4096)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SceneAnalyzer = void 0;
const prompts_1 = require("./prompts");
/** Load VLM configuration from environment */
function loadConfig() {
    return {
        endpoint: (process.env.PERCEPTION_VLM_ENDPOINT || 'https://api.openai.com/v1').replace(/\/$/, ''),
        apiKey: process.env.PERCEPTION_VLM_API_KEY || '',
        model: process.env.PERCEPTION_VLM_MODEL || 'gpt-4o',
        timeoutMs: Math.max(5000, Number(process.env.PERCEPTION_VLM_TIMEOUT) || 25000),
        maxTokens: Math.max(256, Number(process.env.PERCEPTION_VLM_MAX_TOKENS) || 4096),
    };
}
/** Call VLM API with image + text prompt */
async function callVlm(config, imageBase64, prompt) {
    if (!config.apiKey) {
        throw new Error('PERCEPTION_VLM_API_KEY not configured');
    }
    const url = `${config.endpoint}/chat/completions`;
    const body = {
        model: config.model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    {
                        type: 'image_url',
                        image_url: {
                            url: imageBase64.startsWith('data:')
                                ? imageBase64
                                : `data:image/png;base64,${imageBase64}`,
                            detail: 'high',
                        },
                    },
                ],
            },
        ],
        max_tokens: config.maxTokens,
        temperature: 0.1, // Low temperature for factual analysis
        response_format: { type: 'json_object' },
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
        const json = await response.json();
        const content = json.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error('VLM returned empty response');
        }
        return content;
    }
    finally {
        clearTimeout(timeout);
    }
}
/** Parse JSON from VLM response (handles markdown code blocks) */
function parseVlmJson(raw) {
    let cleaned = raw.trim();
    // Remove markdown code block wrapper if present
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(cleaned);
}
class SceneAnalyzer {
    config;
    constructor(config) {
        const envConfig = loadConfig();
        this.config = { ...envConfig, ...config };
    }
    /** Full scene analysis — identifies all objects, relations, hazards */
    async analyze(imageBase64, context) {
        let prompt = prompts_1.SCENE_ANALYSIS_PROMPT;
        if (context) {
            prompt += `\n\nAdditional context: ${context}`;
        }
        const raw = await callVlm(this.config, imageBase64, prompt);
        return parseVlmJson(raw);
    }
    /** Identify a specific object in the scene */
    async identify(imageBase64, target) {
        const prompt = (0, prompts_1.buildPrompt)(prompts_1.IDENTIFY_PROMPT, { target });
        const raw = await callVlm(this.config, imageBase64, prompt);
        return parseVlmJson(raw);
    }
    /** Query spatial relationships */
    async querySpatial(imageBase64, question) {
        const prompt = (0, prompts_1.buildPrompt)(prompts_1.SPATIAL_QUERY_PROMPT, { question });
        const raw = await callVlm(this.config, imageBase64, prompt);
        return parseVlmJson(raw);
    }
    /** Query object state */
    async queryState(imageBase64, object) {
        const prompt = (0, prompts_1.buildPrompt)(prompts_1.STATE_QUERY_PROMPT, { object });
        const raw = await callVlm(this.config, imageBase64, prompt);
        return parseVlmJson(raw);
    }
    /** Analyze object affordances (what can be done with it) */
    async queryAffordance(imageBase64, object) {
        const prompt = (0, prompts_1.buildPrompt)(prompts_1.AFFORDANCE_PROMPT, { object });
        const raw = await callVlm(this.config, imageBase64, prompt);
        return parseVlmJson(raw);
    }
}
exports.SceneAnalyzer = SceneAnalyzer;
//# sourceMappingURL=analyzer.js.map