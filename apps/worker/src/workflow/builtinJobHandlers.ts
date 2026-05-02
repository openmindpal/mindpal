/**
 * builtinJobHandlers.ts — 内置 Job Handler 声明式注册
 *
 * 从 jobDispatcher.ts 提取，将所有非 Skill 管辖的 BullMQ job kind handler
 * 收归到声明式数组，统一注册。
 *
 * 新增 handler 只需在 BUILTIN_JOB_DEFS 中添加一条定义即可，
 * 无需改动 jobDispatcher.ts 分发逻辑。
 */
import { registerJobHandler, type JobDeps } from "./jobDispatcher";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:builtinJobHandlers" });
import { processGovernanceEvalRun } from "../governance/evalExecutor";
import { processAuditExport } from "../audit/exportProcessor";
import { reencryptSecrets } from "../keyring/reencrypt";
import { processMemoryEmbeddingJob } from "../memory/memoryEmbedding";
import { processLoopResume } from "../supervisor/loopResumeHandler";

// ─── 声明式 Handler 定义 ────────────────────────────────────

interface BuiltinJobDef {
  kind: string;
  /** 便于日志 / 调试 */
  label: string;
  handler: (data: any, deps: JobDeps) => Promise<void>;
}

const BUILTIN_JOB_DEFS: BuiltinJobDef[] = [
  {
    kind: "governance.evalrun.execute",
    label: "Governance Eval Run",
    handler: async (data, { pool }) => {
      await processGovernanceEvalRun({
        pool,
        tenantId: String(data.tenantId),
        evalRunId: String(data.evalRunId),
      });
    },
  },
  {
    kind: "audit.export",
    label: "Audit Export",
    handler: async (data, { pool }) => {
      await processAuditExport({
        pool,
        tenantId: String(data.tenantId),
        exportId: String(data.exportId),
        subjectId: String(data.subjectId),
        spaceId: data.spaceId ? String(data.spaceId) : null,
      });
    },
  },
  {
    kind: "keyring.reencrypt",
    label: "Keyring Re-encrypt",
    handler: async (data, { pool, masterKey }) => {
      await reencryptSecrets({
        pool,
        tenantId: String(data.tenantId),
        masterKey,
        scopeType: String(data.scopeType),
        scopeId: String(data.scopeId),
        limit: Number(data.limit ?? 500),
      });
    },
  },
  {
    kind: "memory.embed",
    label: "Memory Embedding",
    handler: async (data, { pool }) => {
      await processMemoryEmbeddingJob({
        pool,
        memoryEntryIds: Array.isArray(data.memoryEntryIds)
          ? data.memoryEntryIds.map(String)
          : [],
        tenantId: String(data.tenantId ?? ""),
        spaceId: String(data.spaceId ?? ""),
      });
    },
  },
  {
    kind: "loop_resume",
    label: "Agent Loop Resume",
    handler: async (data, { pool }) => {
      const result = await processLoopResume(data, { pool });
      if (!result.ok) {
        _logger.warn("loop_resume failed", { loopId: result.loopId, error: result.error });
      } else {
        _logger.info("loop_resume dispatched", { loopId: result.loopId, apiNode: result.apiNode ?? "local", durationMs: result.durationMs });
      }
    },
  },
];

// ─── 注册入口 ────────────────────────────────────────────────

/**
 * 注册所有内置 job handler。
 * 应在 Worker 启动阶段调用一次（runtime.ts 或 index.ts）。
 *
 * 注意：knowledge.index / knowledge.embed / knowledge.ingest / media.process
 * 已通过 Skill 贡献（skills/core/knowledge-rag, skills/optional/media-pipeline）注册，
 * 不在此重复注册。
 */
export function registerBuiltinJobHandlers(): string[] {
  const registered: string[] = [];
  for (const def of BUILTIN_JOB_DEFS) {
    registerJobHandler(def.kind, def.handler);
    registered.push(def.kind);
  }
  return registered;
}

/** 获取所有内置 handler kind（用于健康检查 / 调试） */
export function getBuiltinJobKinds(): string[] {
  return BUILTIN_JOB_DEFS.map((d) => d.kind);
}
