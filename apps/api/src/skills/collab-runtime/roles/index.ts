/**
 * P2-3: CollabRole 统一接口定义
 *
 * 每个角色必须实现以下能力：
 *   - name: 角色名称标识
 *   - capabilities: 角色声明的能力列表
 *   - canHandle: 判断是否能处理某个 step
 *   - execute: 执行一个 step 并返回结果
 *   - validate: 校验 step 输出是否符合预期
 *   - onFailure: 步骤失败时的恢复建议
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:collabRoles" });

/* ================================================================== */
/*  Core Interface                                                      */
/* ================================================================== */

export type RoleCapability =
  | "plan"
  | "retrieve"
  | "execute"
  | "review"
  | "guard"
  | "observe"
  | "coordinate"
  | "audit";

export interface StepContext {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  collabRunId: string;
  taskId: string;
  runId: string;
  stepId: string;
  planStepId: string;
  toolRef: string;
  input: Record<string, unknown>;
  traceId: string;
  masterKey?: string;
}

export interface StepResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  artifacts?: Array<{ ref: string; type: string }>;
  /** 产出的 evidence 摘要 */
  evidenceDigest?: string;
}

export interface RecoverySuggestion {
  action: "retry" | "skip" | "escalate" | "replan" | "abort";
  reason: string;
  maxRetries?: number;
}

export interface CollabRole {
  /** 角色唯一名称 */
  readonly name: string;
  /** 角色声明的能力 */
  readonly capabilities: readonly RoleCapability[];
  /** 角色描述 */
  readonly description: string;

  /** 判断该角色是否能处理指定 step */
  canHandle(stepKind: string, toolRef: string): boolean;

  /** 执行一个 step */
  execute(ctx: StepContext): Promise<StepResult>;

  /** 校验 step 输出 */
  validate(ctx: StepContext, output: Record<string, unknown>): Promise<{ valid: boolean; issues?: string[] }>;

  /** 步骤失败时的恢复建议 */
  onFailure(ctx: StepContext, error: string): RecoverySuggestion;
}

/* ================================================================== */
/*  Role Registry                                                       */
/* ================================================================== */

const roleRegistry = new Map<string, CollabRole>();

export function registerRole(role: CollabRole): void {
  if (roleRegistry.has(role.name)) {
    _logger.warn("role already registered, overwriting", { roleName: role.name });
  }
  roleRegistry.set(role.name, role);
}

export function getRole(name: string): CollabRole | undefined {
  return roleRegistry.get(name);
}

export function listRoles(): CollabRole[] {
  return Array.from(roleRegistry.values());
}

export function findRoleForStep(stepKind: string, toolRef: string): CollabRole | undefined {
  for (const role of roleRegistry.values()) {
    if (role.canHandle(stepKind, toolRef)) return role;
  }
  return undefined;
}

/* Re-export all role implementations for auto-registration */
export { PlannerRole } from "./planner";
export { RetrieverRole } from "./retriever";
export { ExecutorRole } from "./executor";
export { ReviewerRole } from "./reviewer";
export { GuardRole } from "./guard";
