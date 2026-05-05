/**
 * Skill RPC Protocol Conformance Tests
 *
 * Validates JSON-RPC 2.0 compliance for the Skill RPC protocol layer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  SKILL_RPC_VERSION,
  SKILL_RPC_JSONRPC,
  SKILL_RPC_ERRORS,
  SKILL_RPC_METHODS,
  DEVICE_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  createRpcRequest,
  createRpcSuccess,
  createRpcError,
  createRpcNotification,
  serializeRpcMessage,
  parseRpcMessage,
  isRpcRequest,
  isRpcNotification,
  isRpcResponse,
  isRpcError,
  isVersionCompatible,
  negotiateVersion,
  modalityRegistry,
  runtimeRegistry,
  sensitivityProfileRegistry,
  skillErrorCodeRegistry,
  BUILTIN_DEVICE_MODALITIES,
  BUILTIN_SKILL_RUNTIMES,
  BUILTIN_SENSITIVITY_PROFILES,
  BUILTIN_CUSTOM_ERRORS,
} from '../src/skill-rpc';

describe('Skill RPC Protocol — Constants', () => {
  it('SKILL_RPC_JSONRPC is "2.0"', () => {
    expect(SKILL_RPC_JSONRPC).toBe('2.0');
  });

  it('SKILL_RPC_VERSION is defined', () => {
    expect(SKILL_RPC_VERSION).toBe('1.0');
  });

  it('DEVICE_PROTOCOL_VERSION and MIN_SUPPORTED_PROTOCOL_VERSION are defined', () => {
    expect(DEVICE_PROTOCOL_VERSION).toBe('1.0');
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBe('1.0');
  });

  it('PROTOCOL_VERSIONS is a non-empty array', () => {
    expect(PROTOCOL_VERSIONS.length).toBeGreaterThan(0);
    expect(PROTOCOL_VERSIONS).toContain('1.0');
  });
});

describe('Skill RPC Protocol — Standard Error Codes', () => {
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

  it('custom error codes are in server-reserved range (-32000 ~ -32099)', () => {
    const customCodes = [
      SKILL_RPC_ERRORS.EXECUTION_TIMEOUT,
      SKILL_RPC_ERRORS.EXECUTION_FAILED,
      SKILL_RPC_ERRORS.RESOURCE_EXHAUSTED,
      SKILL_RPC_ERRORS.POLICY_VIOLATION,
      SKILL_RPC_ERRORS.DEPENDENCY_ERROR,
      SKILL_RPC_ERRORS.CAPABILITY_DENIED,
    ];
    for (const code of customCodes) {
      expect(code).toBeGreaterThanOrEqual(-32099);
      expect(code).toBeLessThanOrEqual(-32000);
    }
  });
});

describe('Skill RPC Protocol — Method Names', () => {
  it('defines standard method names', () => {
    expect(SKILL_RPC_METHODS.INITIALIZE).toBe('skill.initialize');
    expect(SKILL_RPC_METHODS.EXECUTE).toBe('skill.execute');
    expect(SKILL_RPC_METHODS.HEARTBEAT).toBe('skill.heartbeat');
    expect(SKILL_RPC_METHODS.SHUTDOWN).toBe('skill.shutdown');
    expect(SKILL_RPC_METHODS.PROGRESS).toBe('skill.progress');
    expect(SKILL_RPC_METHODS.LOG).toBe('skill.log');
  });
});

describe('Skill RPC Protocol — createRpcRequest', () => {
  it('produces valid JSON-RPC 2.0 request', () => {
    const req = createRpcRequest(1, 'skill.execute', { input: {} });
    expect(req.jsonrpc).toBe('2.0');
    expect(req.id).toBe(1);
    expect(req.method).toBe('skill.execute');
    expect(req.params).toEqual({ input: {} });
  });

  it('supports string ids', () => {
    const req = createRpcRequest('abc-123', 'skill.initialize', {});
    expect(req.id).toBe('abc-123');
  });
});

describe('Skill RPC Protocol — createRpcSuccess', () => {
  it('produces valid JSON-RPC 2.0 success response', () => {
    const res = createRpcSuccess(1, { output: 'hello' });
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe(1);
    expect(res.result).toEqual({ output: 'hello' });
    expect((res as any).error).toBeUndefined();
  });
});

describe('Skill RPC Protocol — createRpcError', () => {
  it('produces valid JSON-RPC 2.0 error response', () => {
    const err = createRpcError(1, -32600, 'Invalid Request');
    expect(err.jsonrpc).toBe('2.0');
    expect(err.id).toBe(1);
    expect(err.error.code).toBe(-32600);
    expect(err.error.message).toBe('Invalid Request');
    expect(err.error.data).toBeUndefined();
  });

  it('includes optional data field', () => {
    const err = createRpcError(null, -32700, 'Parse error', { detail: 'unexpected token' });
    expect(err.id).toBeNull();
    expect(err.error.data).toEqual({ detail: 'unexpected token' });
  });
});

describe('Skill RPC Protocol — createRpcNotification', () => {
  it('produces valid JSON-RPC 2.0 notification (no id)', () => {
    const notif = createRpcNotification('skill.progress', { progress: 50 });
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('skill.progress');
    expect(notif.params).toEqual({ progress: 50 });
    expect((notif as any).id).toBeUndefined();
  });
});

describe('Skill RPC Protocol — serializeRpcMessage', () => {
  it('outputs valid JSON ending with newline (NDJSON)', () => {
    const req = createRpcRequest(1, 'skill.execute', {});
    const line = serializeRpcMessage(req);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim());
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
  });

  it('serializes notification without id field', () => {
    const notif = createRpcNotification('skill.log', { level: 'info', message: 'test' });
    const line = serializeRpcMessage(notif);
    const parsed = JSON.parse(line.trim());
    expect(parsed.id).toBeUndefined();
    expect(parsed.method).toBe('skill.log');
  });
});

describe('Skill RPC Protocol — parseRpcMessage', () => {
  it('parses valid request', () => {
    const json = '{"jsonrpc":"2.0","id":1,"method":"skill.execute","params":{}}';
    const msg = parseRpcMessage(json);
    expect(msg).not.toBeNull();
    expect(isRpcRequest(msg!)).toBe(true);
  });

  it('parses valid success response', () => {
    const json = '{"jsonrpc":"2.0","id":1,"result":{"output":"ok"}}';
    const msg = parseRpcMessage(json);
    expect(msg).not.toBeNull();
    expect(isRpcResponse(msg!)).toBe(true);
    expect(isRpcError(msg!)).toBe(false);
  });

  it('parses valid error response', () => {
    const json = '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid"}}';
    const msg = parseRpcMessage(json);
    expect(msg).not.toBeNull();
    expect(isRpcError(msg!)).toBe(true);
  });

  it('parses valid notification', () => {
    const json = '{"jsonrpc":"2.0","method":"skill.progress","params":{"progress":75}}';
    const msg = parseRpcMessage(json);
    expect(msg).not.toBeNull();
    expect(isRpcNotification(msg!)).toBe(true);
  });

  it('returns null for empty string', () => {
    expect(parseRpcMessage('')).toBeNull();
    expect(parseRpcMessage('  ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseRpcMessage('{invalid}')).toBeNull();
  });

  it('returns null for non-JSON-RPC object (missing jsonrpc field)', () => {
    expect(parseRpcMessage('{"id":1,"method":"test"}')).toBeNull();
  });

  it('returns null for wrong jsonrpc version', () => {
    expect(parseRpcMessage('{"jsonrpc":"1.0","id":1,"method":"test","params":{}}')).toBeNull();
  });
});

describe('Skill RPC Protocol — NDJSON multi-line parsing', () => {
  it('can parse multiple NDJSON lines independently', () => {
    const lines = [
      serializeRpcMessage(createRpcRequest(1, 'skill.initialize', {})),
      serializeRpcMessage(createRpcNotification('skill.progress', { progress: 50 })),
      serializeRpcMessage(createRpcSuccess(1, { name: 'echo' })),
    ];
    const ndjson = lines.join('');
    const parsed = ndjson.split('\n').filter(Boolean).map(parseRpcMessage);
    expect(parsed).toHaveLength(3);
    expect(parsed.every((m) => m !== null)).toBe(true);
    expect(isRpcRequest(parsed[0]!)).toBe(true);
    expect(isRpcNotification(parsed[1]!)).toBe(true);
    expect(isRpcResponse(parsed[2]!)).toBe(true);
  });
});

describe('Skill RPC Protocol — Type Guard Functions', () => {
  it('isRpcRequest identifies requests', () => {
    const req = createRpcRequest(1, 'test', {});
    expect(isRpcRequest(req)).toBe(true);
    expect(isRpcNotification(req)).toBe(false);
    expect(isRpcResponse(req)).toBe(false);
  });

  it('isRpcNotification identifies notifications', () => {
    const notif = createRpcNotification('test', {});
    expect(isRpcNotification(notif)).toBe(true);
    expect(isRpcRequest(notif)).toBe(false);
  });

  it('isRpcResponse identifies responses', () => {
    const res = createRpcSuccess(1, 'ok');
    expect(isRpcResponse(res)).toBe(true);
    expect(isRpcRequest(res)).toBe(false);
  });

  it('isRpcError identifies error responses', () => {
    const err = createRpcError(1, -32600, 'bad');
    expect(isRpcError(err)).toBe(true);
  });
});

describe('Skill RPC Protocol — Version Negotiation', () => {
  it('isVersionCompatible returns true when client major >= min major', () => {
    expect(isVersionCompatible('1.0', '1.0')).toBe(true);
    expect(isVersionCompatible('2.0', '1.0')).toBe(true);
  });

  it('isVersionCompatible returns false when client major < min major', () => {
    expect(isVersionCompatible('0.9', '1.0')).toBe(false);
  });

  it('isVersionCompatible returns false for invalid version strings', () => {
    expect(isVersionCompatible('abc', '1.0')).toBe(false);
    expect(isVersionCompatible('1.0', 'xyz')).toBe(false);
  });

  it('negotiateVersion returns best compatible version', () => {
    expect(negotiateVersion('1.0', ['1.0'])).toBe('1.0');
    expect(negotiateVersion('2.0', ['1.0', '2.0'])).toBe('2.0');
    expect(negotiateVersion('3.0', ['1.0', '2.0'])).toBe('2.0');
  });

  it('negotiateVersion returns null when no compatible version exists', () => {
    expect(negotiateVersion('0.5', ['1.0', '2.0'])).toBeNull();
  });

  it('negotiateVersion returns null for invalid client version', () => {
    expect(negotiateVersion('invalid', ['1.0'])).toBeNull();
  });

  it('negotiateVersion skips invalid entries in supported list', () => {
    expect(negotiateVersion('1.0', ['abc', '1.0'])).toBe('1.0');
  });
});

/* ================================================================== */
/*  Registry CRUD Tests                                                */
/* ================================================================== */

describe('Skill RPC — modalityRegistry CRUD', () => {
  afterEach(() => { modalityRegistry.reset(); });

  it('has all builtin modalities', () => {
    for (const entry of BUILTIN_DEVICE_MODALITIES) {
      expect(modalityRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom modality', () => {
    modalityRegistry.register({ id: 'lidar', category: 'device.modality', builtIn: false });
    expect(modalityRegistry.has('lidar')).toBe(true);
  });

  it('get returns registered entry', () => {
    expect(modalityRegistry.get('image')).toBeDefined();
    expect(modalityRegistry.get('image')!.category).toBe('device.modality');
  });

  it('list returns all', () => {
    expect(modalityRegistry.list().length).toBeGreaterThanOrEqual(3);
  });

  it('unregister custom entry succeeds', () => {
    modalityRegistry.register({ id: 'thermal', category: 'device.modality', builtIn: false });
    expect(modalityRegistry.unregister('thermal')).toBe(true);
  });

  it('unregister builtIn entry fails', () => {
    expect(modalityRegistry.unregister('image')).toBe(false);
  });

  it('reset restores initial state', () => {
    modalityRegistry.register({ id: 'custom_mod', category: 'device.modality', builtIn: false });
    modalityRegistry.reset();
    expect(modalityRegistry.has('custom_mod')).toBe(false);
    expect(modalityRegistry.has('image')).toBe(true);
  });
});

describe('Skill RPC — runtimeRegistry CRUD', () => {
  afterEach(() => { runtimeRegistry.reset(); });

  it('has all builtin runtimes', () => {
    for (const entry of BUILTIN_SKILL_RUNTIMES) {
      expect(runtimeRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom runtime', () => {
    runtimeRegistry.register({ id: 'deno', category: 'skill.runtime', builtIn: false });
    expect(runtimeRegistry.has('deno')).toBe(true);
  });

  it('unregister builtIn runtime fails', () => {
    expect(runtimeRegistry.unregister('node')).toBe(false);
  });

  it('reset restores initial state', () => {
    runtimeRegistry.register({ id: 'bun', category: 'skill.runtime', builtIn: false });
    runtimeRegistry.reset();
    expect(runtimeRegistry.has('bun')).toBe(false);
    expect(runtimeRegistry.has('node')).toBe(true);
  });
});

describe('Skill RPC — sensitivityProfileRegistry CRUD', () => {
  afterEach(() => { sensitivityProfileRegistry.reset(); });

  it('has all builtin profiles', () => {
    for (const entry of BUILTIN_SENSITIVITY_PROFILES) {
      expect(sensitivityProfileRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom profile', () => {
    sensitivityProfileRegistry.register({ id: 'extreme', category: 'device.vad.sensitivity', builtIn: false });
    expect(sensitivityProfileRegistry.has('extreme')).toBe(true);
  });

  it('unregister builtIn profile fails', () => {
    expect(sensitivityProfileRegistry.unregister('normal')).toBe(false);
  });
});

describe('Skill RPC — skillErrorCodeRegistry CRUD', () => {
  afterEach(() => { skillErrorCodeRegistry.reset(); });

  it('has all builtin error codes', () => {
    for (const entry of BUILTIN_CUSTOM_ERRORS) {
      expect(skillErrorCodeRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom error code', () => {
    skillErrorCodeRegistry.register({ id: 'CUSTOM_ERROR', category: 'skill.error', value: -32050, builtIn: false });
    expect(skillErrorCodeRegistry.has('CUSTOM_ERROR')).toBe(true);
    expect(skillErrorCodeRegistry.get('CUSTOM_ERROR')!.value).toBe(-32050);
  });

  it('unregister builtIn error code fails', () => {
    expect(skillErrorCodeRegistry.unregister('EXECUTION_TIMEOUT')).toBe(false);
  });

  it('reset restores initial state', () => {
    skillErrorCodeRegistry.register({ id: 'TEMP_ERR', category: 'skill.error', value: -32099, builtIn: false });
    skillErrorCodeRegistry.reset();
    expect(skillErrorCodeRegistry.has('TEMP_ERR')).toBe(false);
    expect(skillErrorCodeRegistry.has('EXECUTION_TIMEOUT')).toBe(true);
  });
});
