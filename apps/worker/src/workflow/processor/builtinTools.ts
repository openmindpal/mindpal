import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:builtinTools" });
import { memoryRead, memoryWrite } from "../../memory/processor";
import { knowledgeSearch } from "../../knowledge/search";
import { isPlainObject } from "./common";
import { applyWriteFieldRules, executeEntityCreate, executeEntityDelete, executeEntityUpdate } from "./entity";
import type { EgressEvent, NetworkPolicy, RuntimeLimits } from "./runtime";
import { isDeviceTool, executeDeviceToolDispatch } from "./deviceDispatch";
import { executeSystemToolList, executeSystemToolEnable, executeSystemToolDisable } from "./systemToolGovernance";

// ── 类型定义 ────────────────────────────────────────────────────────

/** executeBuiltinTool 的完整参数类型 */
export type BuiltinToolParams = {
  name: string;
  toolRef: string;
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  runId: string;
  stepId: string;
  policySnapshotRef: string | null;
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
};

/** 内置工具处理函数签名 */
type BuiltinToolHandler = (params: BuiltinToolParams) => Promise<any>;

/** 前缀匹配处理器（用于 device.* / browser.* / desktop.* 等动态工具族） */
interface PrefixToolHandler {
  match: (name: string) => boolean;
  handler: BuiltinToolHandler;
}

// ── 注册表 ──────────────────────────────────────────────────────────

/** 精确名称注册表 */
const exactHandlers = new Map<string, BuiltinToolHandler>();

/** 前缀匹配注册表 */
const prefixHandlers: PrefixToolHandler[] = [];

// ── 注册 API（运行时可动态增删） ────────────────────────────────────

/** 注册精确名称的内置工具处理函数 */
export function registerBuiltinToolHandler(name: string, handler: BuiltinToolHandler): void {
  if (exactHandlers.has(name)) {
    _logger.warn("overriding registered builtin tool handler", { name });
  }
  exactHandlers.set(name, handler);
}

/** 注销精确名称的内置工具处理函数 */
export function unregisterBuiltinToolHandler(name: string): boolean {
  return exactHandlers.delete(name);
}

/** 注册前缀匹配的工具族处理函数 */
export function registerPrefixToolHandler(match: (name: string) => boolean, handler: BuiltinToolHandler): void {
  prefixHandlers.push({ match, handler });
}

/** 列出所有已注册的工具名（用于诊断） */
export function listRegisteredBuiltinTools(): { exact: string[]; prefixCount: number } {
  return { exact: Array.from(exactHandlers.keys()), prefixCount: prefixHandlers.length };
}

// ── 注册全部内置工具处理器 ──────────────────────────────────────────

// entity.create
registerBuiltinToolHandler("entity.create", async (params) => {
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
      traceId: params.traceId,
      runId: params.runId,
      stepId: params.stepId,
      policySnapshotRef: params.policySnapshotRef,
    }),
  );
});

// entity.update
registerBuiltinToolHandler("entity.update", async (params) => {
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
      runId: params.runId,
      stepId: params.stepId,
      policySnapshotRef: params.policySnapshotRef,
    }),
  );
});

// entity.delete
registerBuiltinToolHandler("entity.delete", async (params) => {
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
      runId: params.runId,
      stepId: params.stepId,
      policySnapshotRef: params.policySnapshotRef,
    }),
  );
});

// memory.write
registerBuiltinToolHandler("memory.write", async (params) => {
  if (!params.spaceId) throw new Error("policy_violation:missing_space");
  const subjectId = String(params.subjectId ?? "");
  if (!subjectId) throw new Error("policy_violation:missing_subject");
  if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
  return params.withWriteLease("memory.write", () =>
    memoryWrite({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId as string, subjectId, input: params.toolInput }),
  );
});

// memory.read
registerBuiltinToolHandler("memory.read", async (params) => {
  if (!params.spaceId) throw new Error("policy_violation:missing_space");
  const subjectId = String(params.subjectId ?? "");
  if (!subjectId) throw new Error("policy_violation:missing_subject");
  return memoryRead({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId as string, subjectId, input: params.toolInput });
});

// knowledge.search
registerBuiltinToolHandler("knowledge.search", async (params) => {
  if (!params.spaceId) throw new Error("policy_violation:missing_space");
  const subjectId = String(params.subjectId ?? "");
  if (!subjectId) throw new Error("policy_violation:missing_subject");
  return knowledgeSearch({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId as string, subjectId, input: params.toolInput });
});

// system.tool.list
registerBuiltinToolHandler("system.tool.list", async (params) => {
  return executeSystemToolList({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    toolInput: params.toolInput,
  });
});

// system.tool.enable
registerBuiltinToolHandler("system.tool.enable", async (params) => {
  if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
  return params.withWriteLease("system.tool.enable", () =>
    executeSystemToolEnable({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      traceId: params.traceId,
      toolInput: params.toolInput,
    }),
  );
});

// system.tool.disable
registerBuiltinToolHandler("system.tool.disable", async (params) => {
  if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
  return params.withWriteLease("system.tool.disable", () =>
    executeSystemToolDisable({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      traceId: params.traceId,
      toolInput: params.toolInput,
    }),
  );
});

// device.* / browser.* / desktop.* 工具族（前缀匹配）
registerPrefixToolHandler(isDeviceTool, async (params) => {
  return executeDeviceToolDispatch({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    toolRef: params.toolRef,
    toolName: params.name,
    runId: params.runId,
    stepId: params.stepId,
    policySnapshotRef: params.policySnapshotRef,
    idempotencyKey: params.idempotencyKey,
    toolInput: params.toolInput,
    inputDigest: null,
  });
});

// ── 主执行函数（注册表驱动，零硬编码分发） ──────────────────────────

export async function executeBuiltinTool(params: BuiltinToolParams) {
  // 1. 精确名称匹配
  const handler = exactHandlers.get(params.name);
  if (handler) {
    return handler(params);
  }

  // 2. 前缀匹配（device.* 等动态工具族）
  for (const prefix of prefixHandlers) {
    if (prefix.match(params.name)) {
      return prefix.handler(params);
    }
  }

  // 3. 未注册的工具
  _logger.error("unregistered builtin tool", { name: params.name, exactCount: exactHandlers.size, prefixCount: prefixHandlers.length });
  throw new Error(`policy_violation:unsupported_tool:${params.name}`);
}
