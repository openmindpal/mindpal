/**
 * World State LLM — LLM 辅助提取（可选增强）
 *
 * 使用 LLM 从非结构化工具输出中提取实体/关系/事实。
 * 仅在 output 为非结构化文本或规则提取不充分时使用。
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { resolveBoolean } from "@mindpal/shared";
import type { WorldState } from "@mindpal/shared";
import { upsertEntity, addRelation, upsertFact } from "@mindpal/shared";
import type { StepObservation } from "./loopTypes";
import { invokeModelChat, type LlmSubject } from "../lib/llm";

/* ================================================================== */
/*  LLM 辅助提取接口                                                     */
/* ================================================================== */

export interface LlmExtractParams {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  observation: StepObservation;
  currentState: WorldState;
  defaultModelRef?: string;
}

/**
 * 使用 LLM 从非结构化工具输出中提取实体/关系/事实
 * 仅在 output 为非结构化文本或规则提取不充分时使用
 */
export async function llmExtractWorldState(params: LlmExtractParams): Promise<WorldState> {
  const { app, subject, locale, authorization, traceId, observation, defaultModelRef } = params;
  let state = params.currentState;
  const now = new Date().toISOString();

  // 环境变量开关
  if (!resolveBoolean("AGENT_LOOP_LLM_EXTRACT").value) {
    return state;
  }

  const outputText = JSON.stringify(observation.output ?? observation.outputDigest ?? {}).slice(0, 2000);

  try {
    const systemPrompt = `You are a World State extraction engine. Given a tool execution result, extract entities, relations, and facts.

Output EXACTLY ONE JSON block:
\`\`\`world_state_delta
{
  "entities": [{ "name": "...", "category": "resource|actor|artifact|configuration|external", "state": "created|modified|deleted|active", "properties": {} }],
  "relations": [{ "from": "entity_name", "to": "entity_name", "type": "created_by|depends_on|contains|modifies|references|produces|consumes", "description": "..." }],
  "facts": [{ "category": "observation|inference", "key": "unique_key", "statement": "..." }]
}
\`\`\`
Only extract what is clearly present in the output. Do not hallucinate.`;

    const userPrompt = `Tool: ${observation.toolRef}\nStatus: ${observation.status}\nOutput:\n${outputText}`;

    const result = await invokeModelChat({
      app, subject, locale, authorization, traceId,
      purpose: "agent.loop.extract",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
    });

    const blockMatch = (result.outputText ?? "").match(/```world_state_delta\s*\n?([\s\S]*?)```/);
    if (!blockMatch) return state;

    const parsed = JSON.parse(blockMatch[1].trim());

    // 提取实体
    if (Array.isArray(parsed.entities)) {
      for (const e of parsed.entities) {
        const entityId = crypto.randomUUID();
        state = upsertEntity(state, {
          entityId,
          name: String(e.name ?? ""),
          category: e.category ?? "custom",
          properties: e.properties ?? {},
          state: String(e.state ?? "observed"),
          sourceStepSeq: observation.seq,
          sourceToolRef: observation.toolRef,
          confidence: 0.7, // LLM 提取置信度较低
          discoveredAt: now,
          updatedAt: now,
        });
      }
    }

    // 提取关系
    if (Array.isArray(parsed.relations)) {
      for (const r of parsed.relations) {
        // 查找实体 ID（按名称匹配）
        const fromEntity = Object.values(state.entities).find((e) => e.name === r.from);
        const toEntity = Object.values(state.entities).find((e) => e.name === r.to);
        if (fromEntity && toEntity) {
          state = addRelation(state, {
            relationId: crypto.randomUUID(),
            fromEntityId: fromEntity.entityId,
            toEntityId: toEntity.entityId,
            type: r.type ?? "references",
            description: r.description,
            sourceStepSeq: observation.seq,
            confidence: 0.6,
            establishedAt: now,
          });
        }
      }
    }

    // 提取事实
    if (Array.isArray(parsed.facts)) {
      for (const f of parsed.facts) {
        state = upsertFact(state, {
          factId: crypto.randomUUID(),
          category: f.category ?? "inference",
          key: String(f.key ?? crypto.randomUUID()),
          statement: String(f.statement ?? ""),
          sourceStepSeq: observation.seq,
          sourceToolRef: observation.toolRef,
          confidence: 0.7,
          valid: true,
          recordedAt: now,
        });
      }
    }
  } catch (err: any) {
    app.log.debug({ err: err?.message, toolRef: observation.toolRef }, "[WorldStateExtractor] LLM 提取失败（降级到规则提取）");
  }

  return state;
}
