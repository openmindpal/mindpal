/**
 * Device Handshake Security Protocol Conformance Tests
 *
 * Validates handshake type structures and security policy defaults.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_SECURITY_POLICY,
  authLevelRegistry,
  securityProfileRegistry,
  BUILTIN_AUTH_LEVELS,
  BUILTIN_SECURITY_PROFILES,
} from '../src/device-handshake';
import type {
  DeviceSecurityPolicy,
  HandshakeSecurityExt,
  HandshakeAckSecurityExt,
  DeviceSessionState,
  SecureDeviceMessage,
} from '../src/device-handshake';
import type { ProtocolHandshake, ProtocolHandshakeAck } from '../src/skill-rpc';

describe('Device Handshake — ProtocolHandshake type structure', () => {
  it('can construct a valid ProtocolHandshake object', () => {
    const handshake: ProtocolHandshake = {
      type: 'protocol.handshake',
      protocolVersion: '1.0',
      agentVersion: '0.1.0',
      capabilities: ['multimodal', 'streaming'],
    };
    expect(handshake.type).toBe('protocol.handshake');
    expect(handshake.protocolVersion).toBe('1.0');
    expect(handshake.agentVersion).toBe('0.1.0');
    expect(handshake.capabilities).toEqual(['multimodal', 'streaming']);
  });
});

describe('Device Handshake — ProtocolHandshakeAck type structure', () => {
  it('can construct a valid ProtocolHandshakeAck object', () => {
    const ack: ProtocolHandshakeAck = {
      type: 'protocol.handshake.ack',
      negotiatedVersion: '1.0',
      serverVersion: '2.0.0',
      compatible: true,
    };
    expect(ack.type).toBe('protocol.handshake.ack');
    expect(ack.negotiatedVersion).toBe('1.0');
    expect(ack.serverVersion).toBe('2.0.0');
    expect(ack.compatible).toBe(true);
    expect(ack.deprecationWarning).toBeUndefined();
    expect(ack.multimodalPolicy).toBeUndefined();
  });

  it('supports optional deprecationWarning', () => {
    const ack: ProtocolHandshakeAck = {
      type: 'protocol.handshake.ack',
      negotiatedVersion: '1.0',
      serverVersion: '2.0.0',
      compatible: true,
      deprecationWarning: 'Version 1.0 will be removed in next release',
    };
    expect(ack.deprecationWarning).toContain('removed');
  });

  it('supports optional multimodalPolicy', () => {
    const ack: ProtocolHandshakeAck = {
      type: 'protocol.handshake.ack',
      negotiatedVersion: '1.0',
      serverVersion: '2.0.0',
      compatible: true,
      multimodalPolicy: {
        allowedModalities: ['image', 'audio'],
        maxFileSizeBytes: 10_000_000,
        supportedFormats: { image: ['png', 'jpeg'] },
      },
    };
    expect(ack.multimodalPolicy!.allowedModalities).toContain('image');
  });
});

describe('Device Handshake — V2 Security Extension Fields', () => {
  it('DEFAULT_SECURITY_POLICY has correct format', () => {
    expect(DEFAULT_SECURITY_POLICY.format).toBe('deviceSecurity.v1');
  });

  it('DEFAULT_SECURITY_POLICY has correct authLevel', () => {
    expect(DEFAULT_SECURITY_POLICY.authLevel).toBe('token+ecdh');
  });

  it('DEFAULT_SECURITY_POLICY requires nonce', () => {
    expect(DEFAULT_SECURITY_POLICY.requireNonce).toBe(true);
  });

  it('DEFAULT_SECURITY_POLICY has valid session TTL', () => {
    expect(DEFAULT_SECURITY_POLICY.sessionTtlMs).toBe(3_600_000);
  });

  it('DEFAULT_SECURITY_POLICY has valid key rotation interval', () => {
    expect(DEFAULT_SECURITY_POLICY.keyRotationIntervalMs).toBe(1_800_000);
  });

  it('DEFAULT_SECURITY_POLICY has replay window size', () => {
    expect(DEFAULT_SECURITY_POLICY.replayWindowSize).toBe(256);
  });

  it('HandshakeSecurityExt type can be constructed', () => {
    const ext: HandshakeSecurityExt = {
      nonce: 'a'.repeat(64),
      timestamp: Date.now(),
      ephemeralPubKey: 'base64key',
      hmac: 'hmac-value',
    };
    expect(ext.nonce).toHaveLength(64);
    expect(typeof ext.timestamp).toBe('number');
  });

  it('HandshakeAckSecurityExt type can be constructed', () => {
    const ackExt: HandshakeAckSecurityExt = {
      sessionId: 'sess-001',
      serverNonce: 'b'.repeat(64),
      securityPolicy: DEFAULT_SECURITY_POLICY,
      hmac: 'hmac-server',
    };
    expect(ackExt.sessionId).toBe('sess-001');
    expect(ackExt.securityPolicy.format).toBe('deviceSecurity.v1');
  });

  it('SecureDeviceMessage type has required fields', () => {
    const msg: SecureDeviceMessage = {
      type: 'secure.message',
      sessionId: 'sess-001',
      seq: 1,
      ts: Date.now(),
      enc: 'encrypted-base64',
      iv: 'iv-base64',
      tag: 'tag-base64',
      hmac: 'hmac-value',
    };
    expect(msg.type).toBe('secure.message');
    expect(msg.seq).toBe(1);
  });
});

describe('Device Handshake — Version Backward Compatibility', () => {
  it('negotiatedVersion can differ from protocolVersion', () => {
    const handshake: ProtocolHandshake = {
      type: 'protocol.handshake',
      protocolVersion: '2.0',
      agentVersion: '1.0.0',
      capabilities: [],
    };
    const ack: ProtocolHandshakeAck = {
      type: 'protocol.handshake.ack',
      negotiatedVersion: '1.0',
      serverVersion: '3.0.0',
      compatible: true,
    };
    // Server may negotiate down to older version
    expect(ack.negotiatedVersion).not.toBe(handshake.protocolVersion);
    expect(ack.compatible).toBe(true);
  });

  it('incompatible flag set when versions cannot be reconciled', () => {
    const ack: ProtocolHandshakeAck = {
      type: 'protocol.handshake.ack',
      negotiatedVersion: '',
      serverVersion: '3.0.0',
      compatible: false,
    };
    expect(ack.compatible).toBe(false);
  });
});

describe('Device Handshake — DeviceSecurityPolicy authLevel values', () => {
  it('supports all valid authLevel values', () => {
    const levels: DeviceSecurityPolicy['authLevel'][] = ['token', 'token+ecdh', 'cert+ecdh'];
    for (const level of levels) {
      const policy: DeviceSecurityPolicy = { ...DEFAULT_SECURITY_POLICY, authLevel: level };
      expect(policy.authLevel).toBe(level);
    }
  });
});

/* ================================================================== */
/*  Registry CRUD Tests                                                */
/* ================================================================== */

describe('Device Handshake — authLevelRegistry CRUD', () => {
  afterEach(() => { authLevelRegistry.reset(); });

  it('has all builtin auth levels', () => {
    for (const entry of BUILTIN_AUTH_LEVELS) {
      expect(authLevelRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom auth level', () => {
    authLevelRegistry.register({ id: 'mtls+ecdh', category: 'device.auth', builtIn: false });
    expect(authLevelRegistry.has('mtls+ecdh')).toBe(true);
  });

  it('get returns registered entry', () => {
    const entry = authLevelRegistry.get('token');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('device.auth');
  });

  it('list returns all entries', () => {
    const all = authLevelRegistry.list();
    expect(all.length).toBeGreaterThanOrEqual(BUILTIN_AUTH_LEVELS.length);
  });

  it('unregister custom entry succeeds', () => {
    authLevelRegistry.register({ id: 'temp_auth', category: 'device.auth', builtIn: false });
    expect(authLevelRegistry.unregister('temp_auth')).toBe(true);
    expect(authLevelRegistry.has('temp_auth')).toBe(false);
  });

  it('unregister builtIn entry fails', () => {
    expect(authLevelRegistry.unregister('token')).toBe(false);
    expect(authLevelRegistry.has('token')).toBe(true);
  });

  it('reset restores initial state', () => {
    authLevelRegistry.register({ id: 'custom_auth', category: 'device.auth', builtIn: false });
    authLevelRegistry.reset();
    expect(authLevelRegistry.has('custom_auth')).toBe(false);
    expect(authLevelRegistry.has('token')).toBe(true);
  });
});

describe('Device Handshake — securityProfileRegistry CRUD', () => {
  afterEach(() => { securityProfileRegistry.reset(); });

  it('has all builtin security profiles', () => {
    for (const entry of BUILTIN_SECURITY_PROFILES) {
      expect(securityProfileRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom security profile', () => {
    securityProfileRegistry.register({
      id: 'high_security',
      category: 'device.security_profile',
      value: { name: 'high_security', policy: { ...DEFAULT_SECURITY_POLICY, authLevel: 'cert+ecdh' } },
      builtIn: false,
    });
    expect(securityProfileRegistry.has('high_security')).toBe(true);
  });

  it('unregister builtIn profile fails', () => {
    expect(securityProfileRegistry.unregister('default')).toBe(false);
  });

  it('unregister custom profile succeeds', () => {
    securityProfileRegistry.register({
      id: 'temp_profile',
      category: 'device.security_profile',
      value: { name: 'temp_profile', policy: DEFAULT_SECURITY_POLICY },
      builtIn: false,
    });
    expect(securityProfileRegistry.unregister('temp_profile')).toBe(true);
  });

  it('reset restores initial state', () => {
    securityProfileRegistry.register({
      id: 'custom_profile',
      category: 'device.security_profile',
      value: { name: 'custom_profile', policy: DEFAULT_SECURITY_POLICY },
      builtIn: false,
    });
    securityProfileRegistry.reset();
    expect(securityProfileRegistry.has('custom_profile')).toBe(false);
    expect(securityProfileRegistry.has('default')).toBe(true);
  });
});
