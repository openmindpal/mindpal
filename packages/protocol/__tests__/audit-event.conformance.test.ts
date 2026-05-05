/**
 * Audit Event Protocol Conformance Tests
 *
 * Validates audit error categories, normalization, and utility functions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  AUDIT_ERROR_CATEGORIES,
  HIGH_RISK_AUDIT_ACTIONS,
  AuditContractError,
  normalizeAuditErrorCategory,
  isHighRiskAuditAction,
  generateHumanSummary,
  withPolicySnapshotRef,
  errorCategoryAliasRegistry,
  highRiskActionRegistry,
  BUILTIN_ERROR_CATEGORY_ALIASES,
  BUILTIN_HIGH_RISK_ACTIONS,
} from '../src/audit-event';
import type {
  AuditEventInput,
  DetailedAuditEventInput,
  AuditErrorCategory,
} from '../src/audit-event';

describe('Audit Event — AuditErrorCategory enum values', () => {
  it('contains exactly 5 categories', () => {
    expect(AUDIT_ERROR_CATEGORIES).toHaveLength(5);
  });

  it('includes policy_violation', () => {
    expect(AUDIT_ERROR_CATEGORIES).toContain('policy_violation');
  });

  it('includes validation_error', () => {
    expect(AUDIT_ERROR_CATEGORIES).toContain('validation_error');
  });

  it('includes rate_limited', () => {
    expect(AUDIT_ERROR_CATEGORIES).toContain('rate_limited');
  });

  it('includes upstream_error', () => {
    expect(AUDIT_ERROR_CATEGORIES).toContain('upstream_error');
  });

  it('includes internal_error', () => {
    expect(AUDIT_ERROR_CATEGORIES).toContain('internal_error');
  });
});

describe('Audit Event — normalizeAuditErrorCategory', () => {
  it('normalizes exact matches', () => {
    expect(normalizeAuditErrorCategory('policy_violation')).toBe('policy_violation');
    expect(normalizeAuditErrorCategory('validation_error')).toBe('validation_error');
    expect(normalizeAuditErrorCategory('rate_limited')).toBe('rate_limited');
    expect(normalizeAuditErrorCategory('upstream_error')).toBe('upstream_error');
    expect(normalizeAuditErrorCategory('internal_error')).toBe('internal_error');
  });

  it('normalizes aliases', () => {
    expect(normalizeAuditErrorCategory('internal')).toBe('internal_error');
    expect(normalizeAuditErrorCategory('upstream')).toBe('upstream_error');
    expect(normalizeAuditErrorCategory('invalid_input')).toBe('validation_error');
    expect(normalizeAuditErrorCategory('bad_request')).toBe('validation_error');
    expect(normalizeAuditErrorCategory('throttled')).toBe('rate_limited');
    expect(normalizeAuditErrorCategory('rate_limit')).toBe('rate_limited');
  });

  it('returns null for empty/null input', () => {
    expect(normalizeAuditErrorCategory('')).toBeNull();
    expect(normalizeAuditErrorCategory(null)).toBeNull();
    expect(normalizeAuditErrorCategory(undefined)).toBeNull();
  });

  it('defaults unknown values to internal_error', () => {
    expect(normalizeAuditErrorCategory('unknown_category')).toBe('internal_error');
  });

  it('handles case insensitively', () => {
    expect(normalizeAuditErrorCategory('POLICY_VIOLATION')).toBe('policy_violation');
    expect(normalizeAuditErrorCategory('Rate_Limited')).toBe('rate_limited');
  });
});

describe('Audit Event — isHighRiskAuditAction', () => {
  it('identifies known high-risk actions', () => {
    expect(isHighRiskAuditAction({ resourceType: 'audit', action: 'siem.destination.write' })).toBe(true);
    expect(isHighRiskAuditAction({ resourceType: 'audit', action: 'siem.destination.test' })).toBe(true);
    expect(isHighRiskAuditAction({ resourceType: 'audit', action: 'siem.dlq.clear' })).toBe(true);
    expect(isHighRiskAuditAction({ resourceType: 'audit', action: 'siem.dlq.requeue' })).toBe(true);
  });

  it('returns false for non-high-risk actions', () => {
    expect(isHighRiskAuditAction({ resourceType: 'audit', action: 'read' })).toBe(false);
    expect(isHighRiskAuditAction({ resourceType: 'user', action: 'login' })).toBe(false);
  });

  it('returns false for missing params', () => {
    expect(isHighRiskAuditAction({ resourceType: null, action: null })).toBe(false);
    expect(isHighRiskAuditAction({ resourceType: '', action: '' })).toBe(false);
  });
});

describe('Audit Event — AuditContractError', () => {
  it('constructs with required params', () => {
    const err = new AuditContractError({
      errorCode: 'DUPLICATE_EVENT',
      message: 'Event already exists',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AuditContractError');
    expect(err.errorCode).toBe('DUPLICATE_EVENT');
    expect(err.message).toBe('Event already exists');
    expect(err.httpStatus).toBe(409); // default
  });

  it('supports custom httpStatus', () => {
    const err = new AuditContractError({
      errorCode: 'FORBIDDEN',
      message: 'Access denied',
      httpStatus: 403,
    });
    expect(err.httpStatus).toBe(403);
  });

  it('supports details field', () => {
    const err = new AuditContractError({
      errorCode: 'CONFLICT',
      message: 'Conflict',
      details: { existingId: '123' },
    });
    expect(err.details).toEqual({ existingId: '123' });
  });
});

describe('Audit Event — generateHumanSummary', () => {
  it('generates summary with basic fields', () => {
    const event: DetailedAuditEventInput = {
      resourceType: 'skill',
      action: 'execute',
      result: 'success',
      traceId: 'trace-001',
    };
    const summary = generateHumanSummary(event);
    expect(summary).toContain('skill');
    expect(summary).toContain('execute');
    expect(summary).toContain('成功');
  });

  it('includes subject info when subjectId present', () => {
    const event: DetailedAuditEventInput = {
      subjectId: 'user-12345678-abcd',
      resourceType: 'document',
      action: 'delete',
      result: 'denied',
      traceId: 'trace-002',
    };
    const summary = generateHumanSummary(event);
    expect(summary).toContain('用户');
    expect(summary).toContain('被拒绝');
  });

  it('includes tool and latency info when present', () => {
    const event: DetailedAuditEventInput = {
      resourceType: 'api',
      action: 'call',
      result: 'error',
      traceId: 'trace-003',
      toolRef: 'echo@1.0.0',
      latencyMs: 250,
    };
    const summary = generateHumanSummary(event);
    expect(summary).toContain('echo@1.0.0');
    expect(summary).toContain('250ms');
  });
});

describe('Audit Event — withPolicySnapshotRef', () => {
  it('returns object with policySnapshotRef when base is null', () => {
    const result = withPolicySnapshotRef(null, 'snap-001');
    expect(result).toEqual({ policySnapshotRef: 'snap-001' });
  });

  it('merges policySnapshotRef into existing object', () => {
    const base = { decision: 'allow' };
    const result = withPolicySnapshotRef(base, 'snap-002') as any;
    expect(result.policySnapshotRef).toBe('snap-002');
    expect(result.decision).toBe('allow');
  });

  it('does not override existing policySnapshotRef', () => {
    const base = { policySnapshotRef: 'existing' };
    const result = withPolicySnapshotRef(base, 'new-snap') as any;
    expect(result.policySnapshotRef).toBe('existing');
  });

  it('returns policyDecision as-is when snapshotRef is null', () => {
    expect(withPolicySnapshotRef({ decision: 'allow' }, null)).toEqual({ decision: 'allow' });
    expect(withPolicySnapshotRef(null, null)).toBeNull();
  });
});

describe('Audit Event — AuditEventInput required fields', () => {
  it('type structure contains mandatory fields', () => {
    const event: AuditEventInput = {
      tenantId: 'tenant-001',
      action: 'skill.execute',
      resourceType: 'skill',
      subject: 'user-001',
      outcome: 'success',
    };
    expect(event.tenantId).toBeDefined();
    expect(event.action).toBeDefined();
    expect(event.resourceType).toBeDefined();
    expect(event.subject).toBeDefined();
    expect(event.outcome).toBeDefined();
  });

  it('outcome accepts only valid values', () => {
    const outcomes: AuditEventInput['outcome'][] = ['success', 'failure', 'denied'];
    expect(outcomes).toHaveLength(3);
  });
});

/* ================================================================== */
/*  Registry CRUD Tests                                                */
/* ================================================================== */

describe('Audit Event — errorCategoryAliasRegistry CRUD', () => {
  afterEach(() => { errorCategoryAliasRegistry.reset(); });

  it('has all builtin aliases', () => {
    for (const entry of BUILTIN_ERROR_CATEGORY_ALIASES) {
      expect(errorCategoryAliasRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom alias', () => {
    errorCategoryAliasRegistry.register({ id: 'custom_alias', category: 'audit.error_alias', value: 'internal_error', builtIn: false });
    expect(errorCategoryAliasRegistry.has('custom_alias')).toBe(true);
    expect(errorCategoryAliasRegistry.get('custom_alias')!.value).toBe('internal_error');
  });

  it('get returns registered entry', () => {
    const entry = errorCategoryAliasRegistry.get('internal');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe('internal_error');
  });

  it('list returns all entries', () => {
    const all = errorCategoryAliasRegistry.list();
    expect(all.length).toBeGreaterThanOrEqual(BUILTIN_ERROR_CATEGORY_ALIASES.length);
  });

  it('unregister custom entry succeeds', () => {
    errorCategoryAliasRegistry.register({ id: 'temp_alias', category: 'audit.error_alias', value: 'internal_error', builtIn: false });
    expect(errorCategoryAliasRegistry.unregister('temp_alias')).toBe(true);
    expect(errorCategoryAliasRegistry.has('temp_alias')).toBe(false);
  });

  it('unregister builtIn entry fails', () => {
    expect(errorCategoryAliasRegistry.unregister('internal')).toBe(false);
    expect(errorCategoryAliasRegistry.has('internal')).toBe(true);
  });

  it('reset restores initial state', () => {
    errorCategoryAliasRegistry.register({ id: 'custom_x', category: 'audit.error_alias', value: 'internal_error', builtIn: false });
    errorCategoryAliasRegistry.reset();
    expect(errorCategoryAliasRegistry.has('custom_x')).toBe(false);
    expect(errorCategoryAliasRegistry.has('internal')).toBe(true);
  });
});

describe('Audit Event — highRiskActionRegistry CRUD', () => {
  afterEach(() => { highRiskActionRegistry.reset(); });

  it('has all builtin high risk actions', () => {
    for (const entry of BUILTIN_HIGH_RISK_ACTIONS) {
      expect(highRiskActionRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom high risk action', () => {
    highRiskActionRegistry.register({ id: 'admin:destroy_all', category: 'audit.high_risk', builtIn: false });
    expect(highRiskActionRegistry.has('admin:destroy_all')).toBe(true);
  });

  it('unregister builtIn action fails', () => {
    expect(highRiskActionRegistry.unregister('audit:siem.destination.write')).toBe(false);
  });

  it('unregister custom action succeeds', () => {
    highRiskActionRegistry.register({ id: 'temp:action', category: 'audit.high_risk', builtIn: false });
    expect(highRiskActionRegistry.unregister('temp:action')).toBe(true);
  });

  it('reset restores initial state', () => {
    highRiskActionRegistry.register({ id: 'custom:risk', category: 'audit.high_risk', builtIn: false });
    highRiskActionRegistry.reset();
    expect(highRiskActionRegistry.has('custom:risk')).toBe(false);
    expect(highRiskActionRegistry.has('audit:siem.destination.write')).toBe(true);
  });
});
