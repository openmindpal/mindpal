/**
 * changeSetRepo — barrel re-export
 *
 * 原 3,010 行巨型文件已按领域职责拆分为以下子模块：
 *   changeSetShared.ts       — 类型、行映射器、内部工具函数
 *   changeSetCrud.ts         — CRUD + 生命周期 + 审批门禁
 *   changeSetValidation.ts   — 校验逻辑（validateItem / schema / policy）
 *   changeSetPreflight.ts    — 预检（preflightChangeSet）
 *   changeSetRelease.ts      — 发布（releaseChangeSet）
 *   changeSetPromoteRollback.ts — 晋升 & 回滚
 *
 * 本文件仅做统一 re-export，外部调用者无需修改导入路径。
 */

// ── Types & helpers ────────────────────────────────────────
export type { ChangeSetRow, ChangeSetItemRow, ChangeSetStatus } from "./changeSetShared";
export { toCs, toItem, client, countApprovals, validateToolSupplyChain } from "./changeSetShared";

// ── CRUD + lifecycle + approval gate ───────────────────────
export {
  createChangeSet,
  getChangeSet,
  listChangeSets,
  listChangeSetItems,
  addChangeSetItem,
  submitChangeSet,
  approveChangeSet,
  computeApprovalGate,
  itemMatchesEvalKinds,
} from "./changeSetCrud";

// ── Validation ─────────────────────────────────────────────
export { isPlainObject } from "@mindpal/shared";
export {
  validateItem,
  assertMigrationGate,
  defaultValueForSchemaType,
  generateSchemaMigrationDraftsV1,
  checkPolicyVersionContract,
} from "./changeSetValidation";

// ── Preflight ──────────────────────────────────────────────
export { preflightChangeSet } from "./changeSetPreflight";

// ── Release ────────────────────────────────────────────────
export { releaseChangeSet } from "./changeSetRelease";

// ── Promote & Rollback ─────────────────────────────────────
export { promoteChangeSet, rollbackChangeSet } from "./changeSetPromoteRollback";
