/**
 * agentContext.ts — Kernel 可调用的上下文组装工具 (Facade)
 *
 * 拆分为三个子模块后的薄门面层，保持外部 API 兼容性：
 *   - agentMemoryContext.ts    → 记忆召回
 *   - agentKnowledgeContext.ts → 知识/任务召回
 *   - agentToolCatalog.ts      → 工具发现与缓存
 *
 * 本文件保留通用工具函数 + 重新导出所有子模块的公开 API。
 */

// ─── 重新导出：记忆召回 ─────────────────────────────────────────────
export { recallRelevantMemory, recallProceduralStrategies, interleavedRoundRobin } from "./agentMemoryContext";

// ─── 重新导出：知识/任务召回 ─────────────────────────────────────────
export { recallRecentTasks, recallRelevantKnowledge } from "./agentKnowledgeContext";

// ─── 重新导出：工具发现 ─────────────────────────────────────────────
export { discoverEnabledTools, invalidateToolCatalogQueryCache, inferSemanticMeta, type EnabledTool } from "./agentToolCatalog";
