/**
 * Scene Perception Skill — Entry Point
 * 
 * Universal vision perception for embodied agents.
 * Provides structured understanding of any visual scene
 * without task-specific logic — the Agent Loop decides what to do.
 */

import { SceneAnalyzer } from './analyzer';
import {
  SceneAnalysis,
  IdentifyResult,
  SpatialQueryResult,
  StateResult,
  AffordanceResult,
} from './types';

// --- Input/Output types ---

export interface PerceptionInput {
  command: 'analyze' | 'identify' | 'spatial' | 'state' | 'affordance';
  image: string;
  context?: string;
  target?: string;
  question?: string;
  /** Model configuration injected by platform (optional, overrides env vars) */
  modelConfig?: {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    maxTokens?: number;
  };
}

export interface PerceptionOutput {
  ok: boolean;
  data?: SceneAnalysis | IdentifyResult | SpatialQueryResult | StateResult | AffordanceResult;
  error?: string;
}

// --- Singleton analyzer ---

let analyzer: SceneAnalyzer | null = null;
let lastConfigKey = '';

function getAnalyzer(modelConfig?: PerceptionInput['modelConfig']): SceneAnalyzer {
  // If runtime config provided, check if we need a new analyzer instance
  const configKey = modelConfig
    ? `${modelConfig.endpoint}:${modelConfig.model}`
    : 'env';

  if (!analyzer || configKey !== lastConfigKey) {
    analyzer = new SceneAnalyzer(modelConfig);
    lastConfigKey = configKey;
  }
  return analyzer;
}

// --- Main execute ---

export async function execute(request: { input: PerceptionInput }): Promise<PerceptionOutput> {
  const { command, image, context, target, question } = request.input;

  if (!image) {
    return { ok: false, error: 'Missing required field: image (base64-encoded)' };
  }

  try {
    const a = getAnalyzer(request.input.modelConfig);

    switch (command) {
      case 'analyze': {
        const result = await a.analyze(image, context);
        return { ok: true, data: result };
      }

      case 'identify': {
        if (!target) return { ok: false, error: 'Missing required field: target (object name to find)' };
        const result = await a.identify(image, target);
        return { ok: true, data: result };
      }

      case 'spatial': {
        if (!question) return { ok: false, error: 'Missing required field: question (spatial query)' };
        const result = await a.querySpatial(image, question);
        return { ok: true, data: result };
      }

      case 'state': {
        if (!target) return { ok: false, error: 'Missing required field: target (object to check state)' };
        const result = await a.queryState(image, target);
        return { ok: true, data: result };
      }

      case 'affordance': {
        if (!target) return { ok: false, error: 'Missing required field: target (object to analyze affordances)' };
        const result = await a.queryAffordance(image, target);
        return { ok: true, data: result };
      }

      default:
        return { ok: false, error: `Unknown command: ${command}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Shutdown hook */
export async function shutdown(): Promise<void> {
  analyzer = null;
}
