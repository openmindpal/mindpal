/**
 * Errors Module Conformance Tests
 *
 * Validates error code constants, uniqueness, and range compliance.
 */
import { describe, it, expect } from 'vitest';
import {
  SKILL_RPC_ERRORS,
  PROTOCOL_ERRORS,
  JSONRPC_ERROR_RANGE,
  AUDIT_ERROR_CATEGORIES,
} from '../src/errors';
import type { ProtocolErrorCode, SkillRpcErrorCode } from '../src/errors';

describe('Errors — SKILL_RPC_ERRORS values', () => {
  it('PARSE_ERROR is -32700', () => {
    expect(SKILL_RPC_ERRORS.PARSE_ERROR).toBe(-32700);
  });

  it('INVALID_REQUEST is -32600', () => {
    expect(SKILL_RPC_ERRORS.INVALID_REQUEST).toBe(-32600);
  });

  it('METHOD_NOT_FOUND is -32601', () => {
    expect(SKILL_RPC_ERRORS.METHOD_NOT_FOUND).toBe(-32601);
  });

  it('INVALID_PARAMS is -32602', () => {
    expect(SKILL_RPC_ERRORS.INVALID_PARAMS).toBe(-32602);
  });

  it('INTERNAL_ERROR is -32603', () => {
    expect(SKILL_RPC_ERRORS.INTERNAL_ERROR).toBe(-32603);
  });

  it('EXECUTION_TIMEOUT is -32001', () => {
    expect(SKILL_RPC_ERRORS.EXECUTION_TIMEOUT).toBe(-32001);
  });

  it('EXECUTION_FAILED is -32002', () => {
    expect(SKILL_RPC_ERRORS.EXECUTION_FAILED).toBe(-32002);
  });

  it('RESOURCE_EXHAUSTED is -32003', () => {
    expect(SKILL_RPC_ERRORS.RESOURCE_EXHAUSTED).toBe(-32003);
  });

  it('POLICY_VIOLATION is -32004', () => {
    expect(SKILL_RPC_ERRORS.POLICY_VIOLATION).toBe(-32004);
  });

  it('DEPENDENCY_ERROR is -32005', () => {
    expect(SKILL_RPC_ERRORS.DEPENDENCY_ERROR).toBe(-32005);
  });

  it('CAPABILITY_DENIED is -32006', () => {
    expect(SKILL_RPC_ERRORS.CAPABILITY_DENIED).toBe(-32006);
  });
});

describe('Errors — SKILL_RPC_ERRORS uniqueness', () => {
  it('all numeric error codes are unique', () => {
    const values = Object.values(SKILL_RPC_ERRORS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe('Errors — PROTOCOL_ERRORS values', () => {
  it('VERSION_MISMATCH is defined', () => {
    expect(PROTOCOL_ERRORS.VERSION_MISMATCH).toBe('PROTOCOL_VERSION_MISMATCH');
  });

  it('INVALID_MESSAGE is defined', () => {
    expect(PROTOCOL_ERRORS.INVALID_MESSAGE).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('HANDSHAKE_FAILED is defined', () => {
    expect(PROTOCOL_ERRORS.HANDSHAKE_FAILED).toBe('PROTOCOL_HANDSHAKE_FAILED');
  });

  it('SESSION_EXPIRED is defined', () => {
    expect(PROTOCOL_ERRORS.SESSION_EXPIRED).toBe('PROTOCOL_SESSION_EXPIRED');
  });

  it('REPLAY_DETECTED is defined', () => {
    expect(PROTOCOL_ERRORS.REPLAY_DETECTED).toBe('PROTOCOL_REPLAY_DETECTED');
  });

  it('SIGNATURE_INVALID is defined', () => {
    expect(PROTOCOL_ERRORS.SIGNATURE_INVALID).toBe('PROTOCOL_SIGNATURE_INVALID');
  });

  it('TRANSITION_VIOLATION is defined', () => {
    expect(PROTOCOL_ERRORS.TRANSITION_VIOLATION).toBe('PROTOCOL_TRANSITION_VIOLATION');
  });

  it('CONSENSUS_NOT_REACHED is defined', () => {
    expect(PROTOCOL_ERRORS.CONSENSUS_NOT_REACHED).toBe('PROTOCOL_CONSENSUS_NOT_REACHED');
  });

  it('MANIFEST_INVALID is defined', () => {
    expect(PROTOCOL_ERRORS.MANIFEST_INVALID).toBe('PROTOCOL_MANIFEST_INVALID');
  });
});

describe('Errors — PROTOCOL_ERRORS uniqueness', () => {
  it('all protocol error codes are unique strings', () => {
    const values = Object.values(PROTOCOL_ERRORS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe('Errors — JSONRPC_ERROR_RANGE', () => {
  it('STANDARD_MIN is -32700', () => {
    expect(JSONRPC_ERROR_RANGE.STANDARD_MIN).toBe(-32700);
  });

  it('STANDARD_MAX is -32600', () => {
    expect(JSONRPC_ERROR_RANGE.STANDARD_MAX).toBe(-32600);
  });

  it('SERVER_MIN is -32099', () => {
    expect(JSONRPC_ERROR_RANGE.SERVER_MIN).toBe(-32099);
  });

  it('SERVER_MAX is -32000', () => {
    expect(JSONRPC_ERROR_RANGE.SERVER_MAX).toBe(-32000);
  });

  it('standard range covers all JSON-RPC 2.0 standard errors', () => {
    const standardErrors = [
      SKILL_RPC_ERRORS.PARSE_ERROR,
      SKILL_RPC_ERRORS.INVALID_REQUEST,
      SKILL_RPC_ERRORS.METHOD_NOT_FOUND,
      SKILL_RPC_ERRORS.INVALID_PARAMS,
      SKILL_RPC_ERRORS.INTERNAL_ERROR,
    ];
    for (const code of standardErrors) {
      // Standard errors: -32700 <= code <= -32600
      expect(code).toBeGreaterThanOrEqual(JSONRPC_ERROR_RANGE.STANDARD_MIN);
      expect(code).toBeLessThanOrEqual(JSONRPC_ERROR_RANGE.STANDARD_MAX);
    }
  });

  it('custom error codes are within server-reserved range', () => {
    const customErrors = [
      SKILL_RPC_ERRORS.EXECUTION_TIMEOUT,
      SKILL_RPC_ERRORS.EXECUTION_FAILED,
      SKILL_RPC_ERRORS.RESOURCE_EXHAUSTED,
      SKILL_RPC_ERRORS.POLICY_VIOLATION,
      SKILL_RPC_ERRORS.DEPENDENCY_ERROR,
      SKILL_RPC_ERRORS.CAPABILITY_DENIED,
    ];
    for (const code of customErrors) {
      // Server-reserved range: -32099 <= code <= -32000
      expect(code).toBeGreaterThanOrEqual(JSONRPC_ERROR_RANGE.SERVER_MIN);
      expect(code).toBeLessThanOrEqual(JSONRPC_ERROR_RANGE.SERVER_MAX);
    }
  });
});

describe('Errors — AUDIT_ERROR_CATEGORIES re-export', () => {
  it('re-exports AUDIT_ERROR_CATEGORIES correctly', () => {
    expect(AUDIT_ERROR_CATEGORIES).toHaveLength(5);
    expect(AUDIT_ERROR_CATEGORIES).toContain('policy_violation');
  });
});
