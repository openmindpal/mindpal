import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'));

describe('http-fetch-skill', () => {
  // ── manifest 结构验证 ──────────────────────────────────────────
  describe('manifest.json', () => {
    it('identity.name 存在且非空', () => {
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBe('http.get');
    });

    it('identity.version 符合 semver', () => {
      expect(manifest.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('displayName 包含 zh-CN 和 en-US', () => {
      expect(manifest.displayName['zh-CN']).toBeTruthy();
      expect(manifest.displayName['en-US']).toBeTruthy();
    });

    it('contract 对象存在且 riskLevel 合法', () => {
      expect(manifest.contract).toBeDefined();
      expect(manifest.contract.riskLevel).toMatch(/^(low|medium|high)$/);
    });

    it('io.inputSchema 和 io.outputSchema 存在', () => {
      expect(manifest.io).toBeDefined();
      expect(manifest.io.inputSchema).toBeDefined();
      expect(manifest.io.outputSchema).toBeDefined();
    });

    it('entry 字段存在', () => {
      expect(manifest.entry).toBeTruthy();
    });

    it('inputSchema 定义了 url 字段', () => {
      expect(manifest.io.inputSchema.fields.url).toBeDefined();
      expect(manifest.io.inputSchema.fields.url.type).toBe('string');
    });
  });

  // ── 执行逻辑验证 ──────────────────────────────────────────────
  describe('execute', () => {
    async function loadExecute() {
      const entryPath = join(SKILL_DIR, manifest.entry);
      if (!existsSync(entryPath)) return null;
      const mod = await import(entryPath);
      return (mod.execute ?? mod.default) as (req: unknown) => Promise<any>;
    }

    it('should export execute function', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      expect(typeof execute).toBe('function');
    });

    it('空 URL 返回 status=400', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: { url: '' } });
      expect(result.status).toBe(400);
      expect(result.textLen).toBe(0);
    });

    it('无 url 参数返回 status=400', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: {} });
      expect(result.status).toBe(400);
    });

    it('fetch 成功时返回正确 status 和 textLen', async () => {
      const execute = await loadExecute();
      if (!execute) return;

      const mockResponse = { status: 200, text: async () => 'hello' };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as any;

      try {
        const result = await execute({ input: { url: 'https://example.com' } });
        expect(result.status).toBe(200);
        expect(result.textLen).toBe(5);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('fetch 失败时返回 status=500', async () => {
      const execute = await loadExecute();
      if (!execute) return;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error')) as any;

      try {
        const result = await execute({ input: { url: 'https://bad.url' } });
        expect(result.status).toBe(500);
        expect(result.textLen).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('policy_violation 错误向上冒泡', async () => {
      const execute = await loadExecute();
      if (!execute) return;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('policy_violation: blocked')) as any;

      try {
        await expect(execute({ input: { url: 'https://blocked.url' } }))
          .rejects.toThrow('policy_violation');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
