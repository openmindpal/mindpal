import type { Pool } from "pg";
import { memoryRead, memoryWrite } from "../../memory/processor";
import { knowledgeSearch } from "../../knowledge/search";
import { isPlainObject } from "./common";
import { applyWriteFieldRules, executeEntityCreate, executeEntityDelete, executeEntityUpdate } from "./entity";
import type { EgressEvent, NetworkPolicy, RuntimeLimits } from "./runtime";
import { runtimeFetch } from "./runtime";

export async function executeBuiltinTool(params: {
  name: string;
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  schemaName: string;
  toolInput: any;
  fieldRules: any;
  rowFilters: any;
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  egress: EgressEvent[];
  signal: AbortSignal;
  withWriteLease: <T>(toolName: string, fn: () => Promise<T>) => Promise<T>;
}) {
  if (params.name === "entity.create") {
    const entityName = params.toolInput?.entityName;
    const payload = params.toolInput?.payload;
    if (!entityName) throw new Error("missing_entity_name");
    if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
    if (!isPlainObject(payload)) throw new Error("missing_payload");
    if (!params.subjectId) throw new Error("policy_violation:missing_subject_id");
    applyWriteFieldRules(payload as any, params.fieldRules);
    return params.withWriteLease("entity.create", () =>
      executeEntityCreate({
        pool: params.pool,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        ownerSubjectId: params.subjectId as string,
        idempotencyKey: params.idempotencyKey as string,
        schemaName: params.schemaName,
        entityName,
        payload,
      }),
    );
  }

  if (params.name === "entity.update") {
    const entityName = params.toolInput?.entityName;
    const id = params.toolInput?.id;
    const patch = params.toolInput?.patch;
    const expectedRevision = params.toolInput?.expectedRevision;
    if (!entityName || !id) throw new Error("missing_entity_or_id");
    if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
    if (!isPlainObject(patch)) throw new Error("missing_patch");
    if (!params.subjectId) throw new Error("policy_violation:missing_subject_id");
    applyWriteFieldRules(patch as any, params.fieldRules);
    return params.withWriteLease("entity.update", () =>
      executeEntityUpdate({
        pool: params.pool,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        ownerSubjectId: params.subjectId as string,
        rowFilters: params.rowFilters,
        idempotencyKey: params.idempotencyKey as string,
        schemaName: params.schemaName,
        entityName,
        id,
        patch,
        expectedRevision,
        traceId: params.traceId,
      }),
    );
  }

  if (params.name === "entity.delete") {
    const entityName = params.toolInput?.entityName;
    const id = params.toolInput?.id;
    if (!entityName || !id) throw new Error("missing_entity_or_id");
    if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
    if (!params.subjectId) throw new Error("policy_violation:missing_subject_id");
    return params.withWriteLease("entity.delete", () =>
      executeEntityDelete({
        pool: params.pool,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        ownerSubjectId: params.subjectId as string,
        rowFilters: params.rowFilters,
        idempotencyKey: params.idempotencyKey as string,
        schemaName: params.schemaName,
        entityName,
        id,
        traceId: params.traceId,
      }),
    );
  }

  if (params.name === "sleep") {
    const ms = typeof params.toolInput?.ms === "number" && Number.isFinite(params.toolInput.ms) && params.toolInput.ms >= 0 ? params.toolInput.ms : 0;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("timeout"));
      };
      if (params.signal.aborted) return onAbort();
      params.signal.addEventListener("abort", onAbort, { once: true });
    });
    return { sleptMs: ms };
  }

  if (params.name === "http.get") {
    const url = String(params.toolInput?.url ?? "");
    if (!url) throw new Error("missing_url");
    const res = await runtimeFetch({ url, method: "GET", networkPolicy: params.networkPolicy, signal: params.signal, egress: params.egress, maxEgressRequests: params.limits.maxEgressRequests });
    const body = await res.text();
    return { status: res.status, textLen: body.length };
  }

  if (params.name === "memory.write") {
    if (!params.spaceId) throw new Error("policy_violation:missing_space");
    const subjectId = String(params.subjectId ?? "");
    if (!subjectId) throw new Error("policy_violation:missing_subject");
    if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
    return params.withWriteLease("memory.write", () =>
      memoryWrite({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId as string, subjectId, input: params.toolInput }),
    );
  }

  if (params.name === "memory.read") {
    if (!params.spaceId) throw new Error("policy_violation:missing_space");
    const subjectId = String(params.subjectId ?? "");
    if (!subjectId) throw new Error("policy_violation:missing_subject");
    return memoryRead({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId as string, subjectId, input: params.toolInput });
  }

  if (params.name === "knowledge.search") {
    if (!params.spaceId) throw new Error("policy_violation:missing_space");
    const subjectId = String(params.subjectId ?? "");
    if (!subjectId) throw new Error("policy_violation:missing_subject");
    return knowledgeSearch({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId as string, subjectId, input: params.toolInput });
  }

  throw new Error(`policy_violation:unsupported_tool:${params.name}`);
}
