/**
 * Working Memory Skill - Entry Point
 *
 * Provides high-speed layered working memory for real-time agent decisions.
 * This skill is designed for transient data that does NOT persist to long-term storage.
 * Use 'promote' command to graduate important entries to long-term memory.
 */
export interface WorkingMemoryInput {
    command: 'set' | 'get' | 'getMany' | 'scan' | 'delete' | 'flush' | 'promote' | 'stats';
    namespace: string;
    key?: string;
    value?: unknown;
    keys?: string[];
    options?: {
        ttlMs?: number;
        tags?: string[];
        importance?: number;
        prefix?: string;
        minImportance?: number;
        targetType?: 'episodic' | 'semantic' | 'procedural';
    };
}
export interface WorkingMemoryOutput {
    ok: boolean;
    data?: unknown;
    stats?: {
        l1Size: number;
        l1Hits: number;
        l1Misses: number;
        l2Hits: number;
        l2Misses: number;
    };
    error?: string;
}
export declare function execute(request: {
    input: WorkingMemoryInput;
}): Promise<WorkingMemoryOutput>;
/** Shutdown hook */
export declare function shutdown(): Promise<void>;
//# sourceMappingURL=index.d.ts.map