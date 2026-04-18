/**
 * permissionActions.ts — 权限动作名集中注册
 *
 * 所有 requirePermission({ resourceType, action }) 中使用的常量集中定义在此，
 * 避免各路由文件中散落的字符串字面量。
 *
 * 使用方式:
 *   import { PERM } from "@openslin/shared";
 *   await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_ENABLE });
 */

export type PermissionAction = { readonly resourceType: string; readonly action: string };

// ── Governance: Tools ──
const GOVERNANCE_TOOL_READ: PermissionAction = { resourceType: "governance", action: "tool.read" };
const GOVERNANCE_TOOL_MANAGE: PermissionAction = { resourceType: "governance", action: "tool.manage" };
const GOVERNANCE_TOOL_ENABLE: PermissionAction = { resourceType: "governance", action: "tool.enable" };
const GOVERNANCE_TOOL_DISABLE: PermissionAction = { resourceType: "governance", action: "tool.disable" };
const GOVERNANCE_TOOL_SET_ACTIVE: PermissionAction = { resourceType: "governance", action: "tool.set_active" };
const GOVERNANCE_TOOL_NETWORK_POLICY_READ: PermissionAction = { resourceType: "governance", action: "tool.network_policy.read" };
const GOVERNANCE_TOOL_NETWORK_POLICY_WRITE: PermissionAction = { resourceType: "governance", action: "tool.network_policy.write" };

// ── Governance: Changesets & Evals ──
const GOVERNANCE_CHANGESET_CREATE: PermissionAction = { resourceType: "governance", action: "changeset.create" };
const GOVERNANCE_CHANGESET_UPDATE: PermissionAction = { resourceType: "governance", action: "changeset.update" };
const GOVERNANCE_CHANGESET_READ: PermissionAction = { resourceType: "governance", action: "changeset.read" };
const GOVERNANCE_EVALRUN_EXECUTE: PermissionAction = { resourceType: "governance", action: "evalrun.execute" };
const GOVERNANCE_EVALRUN_READ: PermissionAction = { resourceType: "governance", action: "evalrun.read" };
const GOVERNANCE_EVALSUITE_WRITE: PermissionAction = { resourceType: "governance", action: "evalsuite.write" };
const GOVERNANCE_EVALSUITE_READ: PermissionAction = { resourceType: "governance", action: "evalsuite.read" };

// ── Governance: Federation ──
const GOVERNANCE_FEDERATION_READ: PermissionAction = { resourceType: "governance", action: "federation.read" };

// ── RBAC ──
const RBAC_MANAGE: PermissionAction = { resourceType: "rbac", action: "manage" };

// ── Workflow ──
const WORKFLOW_CREATE: PermissionAction = { resourceType: "workflow", action: "create" };
const WORKFLOW_READ: PermissionAction = { resourceType: "workflow", action: "read" };

// ── Backup ──
const BACKUP_LIST: PermissionAction = { resourceType: "backup", action: "list" };
const BACKUP_GET: PermissionAction = { resourceType: "backup", action: "get" };
const BACKUP_CREATE: PermissionAction = { resourceType: "backup", action: "create" };

// ── Orchestrator ──
const ORCHESTRATOR_TURN: PermissionAction = { resourceType: "orchestrator", action: "turn" };
const ORCHESTRATOR_EXECUTE: PermissionAction = { resourceType: "orchestrator", action: "execute" };
const ORCHESTRATOR_DISPATCH: PermissionAction = { resourceType: "orchestrator", action: "dispatch" };
const ORCHESTRATOR_DISPATCH_STREAM: PermissionAction = { resourceType: "orchestrator", action: "dispatch.stream" };

// ── Model ──
const MODEL_READ: PermissionAction = { resourceType: "model", action: "read" };
const MODEL_WRITE: PermissionAction = { resourceType: "model", action: "write" };
const MODEL_BIND: PermissionAction = { resourceType: "model", action: "bind" };
const MODEL_INVOKE: PermissionAction = { resourceType: "model", action: "invoke" };

// ── Device Execution ──
const DEVICE_EXECUTION_CREATE: PermissionAction = { resourceType: "device_execution", action: "create" };
const DEVICE_EXECUTION_READ: PermissionAction = { resourceType: "device_execution", action: "read" };

// ── Connector ──
const CONNECTOR_CREATE: PermissionAction = { resourceType: "connector", action: "create" };

// ── Secret ──
const SECRET_CREATE: PermissionAction = { resourceType: "secret", action: "create" };

// ── Schema ──
const SCHEMA_READ: PermissionAction = { resourceType: "schema", action: "read" };

// ── Entity ──
const ENTITY_READ: PermissionAction = { resourceType: "entity", action: "read" };
const ENTITY_CREATE: PermissionAction = { resourceType: "entity", action: "create" };
const ENTITY_UPDATE: PermissionAction = { resourceType: "entity", action: "update" };
const ENTITY_DELETE: PermissionAction = { resourceType: "entity", action: "delete" };

// ── Governance: Workflow ──
const GOVERNANCE_WORKFLOW_DEADLETTER_READ: PermissionAction = { resourceType: "governance", action: "workflow.deadletter.read" };
const GOVERNANCE_WORKFLOW_DEADLETTER_RETRY: PermissionAction = { resourceType: "governance", action: "workflow.deadletter.retry" };
const GOVERNANCE_WORKFLOW_DEADLETTER_CANCEL: PermissionAction = { resourceType: "governance", action: "workflow.deadletter.cancel" };
const GOVERNANCE_WORKFLOW_STEP_OUTPUT_REVEAL: PermissionAction = { resourceType: "governance", action: "workflow.step.output.reveal" };
const GOVERNANCE_WORKFLOW_STEP_COMPENSATE: PermissionAction = { resourceType: "governance", action: "workflow.step.compensate" };
const GOVERNANCE_WORKFLOW_STEP_COMPENSATION_RETRY: PermissionAction = { resourceType: "governance", action: "workflow.step.compensation.retry" };
const GOVERNANCE_WORKFLOW_STEP_COMPENSATION_CANCEL: PermissionAction = { resourceType: "governance", action: "workflow.step.compensation.cancel" };

// ── Workflow (extended) ──
const WORKFLOW_CANCEL: PermissionAction = { resourceType: "workflow", action: "cancel" };
const WORKFLOW_RETRY: PermissionAction = { resourceType: "workflow", action: "retry" };
const WORKFLOW_PAUSE: PermissionAction = { resourceType: "workflow", action: "pause" };
const WORKFLOW_RESUME: PermissionAction = { resourceType: "workflow", action: "resume" };
const WORKFLOW_REPLAN: PermissionAction = { resourceType: "workflow", action: "replan" };
const WORKFLOW_STEP_INSERT: PermissionAction = { resourceType: "workflow", action: "step.insert" };
const WORKFLOW_STEP_REMOVE: PermissionAction = { resourceType: "workflow", action: "step.remove" };

// ── Backup (extended) ──
const BACKUP_RESTORE: PermissionAction = { resourceType: "backup", action: "restore" };

// ── Space ──
const SPACE_CREATE: PermissionAction = { resourceType: "space", action: "create" };

// ── Tool ──
const TOOL_READ: PermissionAction = { resourceType: "tool", action: "read" };
const TOOL_PUBLISH: PermissionAction = { resourceType: "tool", action: "publish" };
const TOOL_EXECUTE: PermissionAction = { resourceType: "tool", action: "execute" };

// ── Audit ──
const AUDIT_READ: PermissionAction = { resourceType: "audit", action: "read" };
const AUDIT_VERIFY: PermissionAction = { resourceType: "audit", action: "verify" };
const AUDIT_LEGAL_HOLD_MANAGE: PermissionAction = { resourceType: "audit", action: "legalHold.manage" };
const AUDIT_EXPORT: PermissionAction = { resourceType: "audit", action: "export" };
const AUDIT_SIEM_DESTINATION_READ: PermissionAction = { resourceType: "audit", action: "siem.destination.read" };
const AUDIT_SIEM_DESTINATION_WRITE: PermissionAction = { resourceType: "audit", action: "siem.destination.write" };
const AUDIT_SIEM_DESTINATION_TEST: PermissionAction = { resourceType: "audit", action: "siem.destination.test" };
const AUDIT_SIEM_DESTINATION_BACKFILL: PermissionAction = { resourceType: "audit", action: "siem.destination.backfill" };
const AUDIT_SIEM_DLQ_READ: PermissionAction = { resourceType: "audit", action: "siem.dlq.read" };
const AUDIT_SIEM_DLQ_WRITE: PermissionAction = { resourceType: "audit", action: "siem.dlq.write" };

// ── Governance: Diagnostics ──
const GOVERNANCE_DIAGNOSTICS_READ: PermissionAction = { resourceType: "governance", action: "diagnostics.read" };
const GOVERNANCE_DIAGNOSTICS_DUMP: PermissionAction = { resourceType: "governance", action: "diagnostics.dump" };

// ── Device ──
const DEVICE_CREATE: PermissionAction = { resourceType: "device", action: "create" };
const DEVICE_READ: PermissionAction = { resourceType: "device", action: "read" };
const DEVICE_PAIRING_CREATE: PermissionAction = { resourceType: "device", action: "pairing.create" };
const DEVICE_REVOKE: PermissionAction = { resourceType: "device", action: "revoke" };
const DEVICE_POLICY_UPDATE: PermissionAction = { resourceType: "device", action: "policy.update" };
const DEVICE_EXECUTION_CANCEL: PermissionAction = { resourceType: "device_execution", action: "cancel" };
const DEVICE_MESSAGE_SEND: PermissionAction = { resourceType: "device_message", action: "send" };
const DEVICE_MESSAGE_READ: PermissionAction = { resourceType: "device_message", action: "read" };

// ── Agent Runtime (Collab) ──
const AGENT_RUNTIME_COLLAB_READ: PermissionAction = { resourceType: "agent_runtime", action: "collab.read" };
const AGENT_RUNTIME_COLLAB_CREATE: PermissionAction = { resourceType: "agent_runtime", action: "collab.create" };
const AGENT_RUNTIME_COLLAB_ENVELOPES_WRITE: PermissionAction = { resourceType: "agent_runtime", action: "collab.envelopes.write" };
const AGENT_RUNTIME_COLLAB_ENVELOPES_READ: PermissionAction = { resourceType: "agent_runtime", action: "collab.envelopes.read" };
const AGENT_RUNTIME_COLLAB_ARBITER_COMMIT: PermissionAction = { resourceType: "agent_runtime", action: "collab.arbiter.commit" };
const AGENT_RUNTIME_COLLAB_EVENTS: PermissionAction = { resourceType: "agent_runtime", action: "collab.events" };

// ── Skill ──
const SKILL_READ: PermissionAction = { resourceType: "skill", action: "read" };
const SKILL_WRITE: PermissionAction = { resourceType: "skill", action: "write" };

// ── Memory (used in extraPermissions metadata) ──
const MEMORY_READ: PermissionAction = { resourceType: "memory", action: "read" };
const MEMORY_WRITE: PermissionAction = { resourceType: "memory", action: "write" };
const MEMORY_TASK_STATE: PermissionAction = { resourceType: "memory", action: "task_state" };

/**
 * All permission action constants, grouped by module.
 *
 * Usage:
 *   import { PERM } from "@openslin/shared";
 *   requirePermission({ req, ...PERM.GOVERNANCE_TOOL_ENABLE });
 */
export const PERM = {
  // Governance: Tools
  GOVERNANCE_TOOL_READ,
  GOVERNANCE_TOOL_MANAGE,
  GOVERNANCE_TOOL_ENABLE,
  GOVERNANCE_TOOL_DISABLE,
  GOVERNANCE_TOOL_SET_ACTIVE,
  GOVERNANCE_TOOL_NETWORK_POLICY_READ,
  GOVERNANCE_TOOL_NETWORK_POLICY_WRITE,
  // Governance: Changesets & Evals
  GOVERNANCE_CHANGESET_CREATE,
  GOVERNANCE_CHANGESET_UPDATE,
  GOVERNANCE_CHANGESET_READ,
  GOVERNANCE_EVALRUN_EXECUTE,
  GOVERNANCE_EVALRUN_READ,
  GOVERNANCE_EVALSUITE_WRITE,
  GOVERNANCE_EVALSUITE_READ,
  // Governance: Federation
  GOVERNANCE_FEDERATION_READ,
  // RBAC
  RBAC_MANAGE,
  // Workflow
  WORKFLOW_CREATE,
  WORKFLOW_READ,
  // Backup
  BACKUP_LIST,
  BACKUP_GET,
  BACKUP_CREATE,
  // Orchestrator
  ORCHESTRATOR_TURN,
  ORCHESTRATOR_EXECUTE,
  ORCHESTRATOR_DISPATCH,
  ORCHESTRATOR_DISPATCH_STREAM,
  // Model
  MODEL_READ,
  MODEL_WRITE,
  MODEL_BIND,
  MODEL_INVOKE,
  // Device Execution
  DEVICE_EXECUTION_CREATE,
  DEVICE_EXECUTION_READ,
  // Connector
  CONNECTOR_CREATE,
  // Secret
  SECRET_CREATE,
  // Schema
  SCHEMA_READ,
  // Entity
  ENTITY_READ,
  ENTITY_CREATE,
  ENTITY_UPDATE,
  ENTITY_DELETE,
  // Governance: Workflow
  GOVERNANCE_WORKFLOW_DEADLETTER_READ,
  GOVERNANCE_WORKFLOW_DEADLETTER_RETRY,
  GOVERNANCE_WORKFLOW_DEADLETTER_CANCEL,
  GOVERNANCE_WORKFLOW_STEP_OUTPUT_REVEAL,
  GOVERNANCE_WORKFLOW_STEP_COMPENSATE,
  GOVERNANCE_WORKFLOW_STEP_COMPENSATION_RETRY,
  GOVERNANCE_WORKFLOW_STEP_COMPENSATION_CANCEL,
  // Workflow (extended)
  WORKFLOW_CANCEL,
  WORKFLOW_RETRY,
  WORKFLOW_PAUSE,
  WORKFLOW_RESUME,
  WORKFLOW_REPLAN,
  WORKFLOW_STEP_INSERT,
  WORKFLOW_STEP_REMOVE,
  // Backup (extended)
  BACKUP_RESTORE,
  // Space
  SPACE_CREATE,
  // Tool
  TOOL_READ,
  TOOL_PUBLISH,
  TOOL_EXECUTE,
  // Audit
  AUDIT_READ,
  AUDIT_VERIFY,
  AUDIT_LEGAL_HOLD_MANAGE,
  AUDIT_EXPORT,
  AUDIT_SIEM_DESTINATION_READ,
  AUDIT_SIEM_DESTINATION_WRITE,
  AUDIT_SIEM_DESTINATION_TEST,
  AUDIT_SIEM_DESTINATION_BACKFILL,
  AUDIT_SIEM_DLQ_READ,
  AUDIT_SIEM_DLQ_WRITE,
  // Governance: Diagnostics
  GOVERNANCE_DIAGNOSTICS_READ,
  GOVERNANCE_DIAGNOSTICS_DUMP,
  // Device
  DEVICE_CREATE,
  DEVICE_READ,
  DEVICE_PAIRING_CREATE,
  DEVICE_REVOKE,
  DEVICE_POLICY_UPDATE,
  DEVICE_EXECUTION_CANCEL,
  DEVICE_MESSAGE_SEND,
  DEVICE_MESSAGE_READ,
  // Agent Runtime (Collab)
  AGENT_RUNTIME_COLLAB_READ,
  AGENT_RUNTIME_COLLAB_CREATE,
  AGENT_RUNTIME_COLLAB_ENVELOPES_WRITE,
  AGENT_RUNTIME_COLLAB_ENVELOPES_READ,
  AGENT_RUNTIME_COLLAB_ARBITER_COMMIT,
  AGENT_RUNTIME_COLLAB_EVENTS,
  // Skill
  SKILL_READ,
  SKILL_WRITE,
  // Memory
  MEMORY_READ,
  MEMORY_WRITE,
  MEMORY_TASK_STATE,
} as const;
