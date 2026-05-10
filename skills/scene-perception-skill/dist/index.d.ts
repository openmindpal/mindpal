/**
 * Scene Perception Skill — Entry Point
 *
 * Universal vision perception for embodied agents.
 * Provides structured understanding of any visual scene
 * without task-specific logic — the Agent Loop decides what to do.
 */
import { SceneAnalysis, IdentifyResult, SpatialQueryResult, StateResult, AffordanceResult } from './types';
export interface PerceptionInput {
    command: 'analyze' | 'identify' | 'spatial' | 'state' | 'affordance';
    image: string;
    context?: string;
    target?: string;
    question?: string;
}
export interface PerceptionOutput {
    ok: boolean;
    data?: SceneAnalysis | IdentifyResult | SpatialQueryResult | StateResult | AffordanceResult;
    error?: string;
}
export declare function execute(request: {
    input: PerceptionInput;
}): Promise<PerceptionOutput>;
/** Shutdown hook */
export declare function shutdown(): Promise<void>;
//# sourceMappingURL=index.d.ts.map