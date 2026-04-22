/**
 * Agent Loop — 自动反思（Auto-Reflexion）
 *
 * 循环结束后异步触发，不阻塞主流程。
 * 写入 procedural 级策略记忆（type=strategy，memory_class=procedural），
 * 与 activeReflexion 输出统一，经 recallProceduralStrategies 专用召回。
 */
import crypto from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { computeMinhash, resolveBoolean } from "@openslin/shared";
import type { AgentLoopResult } from "./loopTypes";
import { encryptMemoryContent } from "../modules/memory/memoryEncryption";

/**
 * 加载 reflexion-skill。
 */
function loadReflexionSkill(): { execute: (params: any) => Promise<any> } | null {
  const skillPaths = [
    path.resolve(process.cwd(), "skills/reflexion-skill/dist/index.js"),
    path.resolve(__dirname, "../../../../skills/reflexion-skill/dist/index.js"),
  ];
  for (const sp of skillPaths) {
    try {
      const mod = require(sp);
      if (typeof mod?.execute === "function") return mod;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 加载 reflexion-skill 并执行反思，将策略写入 memory_entries（type=strategy, memory_class=procedural）。
 * 完全异步 fire-and-forget，不影响主流程返回。
 */
export async function triggerAutoReflexion(params: {
  pool: Pool;
  app: FastifyInstance;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  runId: string;
  goal: string;
  result: AgentLoopResult;
}) {
  // 环境变量开关（默认启用）
  if (!resolveBoolean("AGENT_LOOP_AUTO_REFLEXION").value) return;
  // 无执行步骤则跳过
  if (params.result.iterations === 0 || params.result.observations.length === 0) return;
  // ask_user 是暂停状态，循环会恢复，不需要反思
  if (params.result.endReason === "ask_user") return;

  try {
    const reflexionSkill = loadReflexionSkill();
    if (!reflexionSkill) {
      params.app.log.debug({ runId: params.runId }, "[AgentLoop] reflexion-skill 未找到，跳过自动反思");
      return;
    }

    // 准备反思输入
    const steps = params.result.observations.map(obs => ({
      seq: obs.seq,
      toolRef: obs.toolRef,
      status: obs.status,
      durationMs: obs.durationMs,
      error: obs.errorCategory,
    }));
    const outcome = params.result.ok ? "succeeded"
      : params.result.endReason === "aborted" ? "failed"
      : params.result.endReason;

    const reflexionResult = await reflexionSkill.execute({
      input: {
        goal: params.goal,
        outcome,
        steps,
        context: `runId=${params.runId}, iterations=${params.result.iterations}, succeeded=${params.result.succeededSteps}, failed=${params.result.failedSteps}`,
        requestStrategy: true,
      },
    });

    // 优先使用 strategy，回退到 lesson
    const strategyText = String(reflexionResult?.strategy ?? reflexionResult?.lesson ?? "").trim();
    if (!strategyText) return;

    const minhash = computeMinhash(strategyText);
    const title = `[策略] ${params.goal.slice(0, 50)}`;
    const contentDigest = crypto.createHash("sha256").update(strategyText, "utf8").digest("hex");
    const confidence = typeof reflexionResult?.confidence === "number" ? reflexionResult.confidence : 0.7;

    // 加密内容
    const storedContent = await encryptMemoryContent({
      pool: params.pool,
      tenantId: params.tenantId,
      plaintext: strategyText,
    });

    await params.pool.query(
      `INSERT INTO memory_entries (
        tenant_id, space_id, owner_subject_id, scope, type, title,
        content_text, content_digest, write_policy, source_ref,
        embedding_model_ref, embedding_minhash, embedding_updated_at,
        memory_class, confidence
      ) VALUES ($1,$2,$3,'space','strategy',$4,$5,$6,'policyAllowed',$7,'minhash:16@1',$8,now(),'procedural',$9)`,
      [
        params.tenantId,
        params.spaceId,
        params.subjectId,
        title,
        storedContent,
        contentDigest,
        JSON.stringify({
          kind: "auto_reflexion",
          runId: params.runId,
          endReason: params.result.endReason,
          iterations: params.result.iterations,
          succeededSteps: params.result.succeededSteps,
          failedSteps: params.result.failedSteps,
        }),
        minhash,
        Math.max(0.5, Math.min(1, confidence)),
      ],
    );

    params.app.log.info(
      { runId: params.runId, strategyLen: strategyText.length, confidence },
      "[AgentLoop] 自动反思策略已写入 procedural 记忆",
    );
  } catch (err: any) {
    params.app.log.warn(
      { err: err?.message, runId: params.runId },
      "[AgentLoop] 自动反思失败（不影响主流程）",
    );
  }
}
