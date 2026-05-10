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
import { SceneAnalysis, IdentifyResult, SpatialQueryResult, StateResult, AffordanceResult, VlmConfig } from './types';
export declare class SceneAnalyzer {
    private config;
    constructor(config?: Partial<VlmConfig>);
    /** Full scene analysis — identifies all objects, relations, hazards */
    analyze(imageBase64: string, context?: string): Promise<SceneAnalysis>;
    /** Identify a specific object in the scene */
    identify(imageBase64: string, target: string): Promise<IdentifyResult>;
    /** Query spatial relationships */
    querySpatial(imageBase64: string, question: string): Promise<SpatialQueryResult>;
    /** Query object state */
    queryState(imageBase64: string, object: string): Promise<StateResult>;
    /** Analyze object affordances (what can be done with it) */
    queryAffordance(imageBase64: string, object: string): Promise<AffordanceResult>;
}
//# sourceMappingURL=analyzer.d.ts.map