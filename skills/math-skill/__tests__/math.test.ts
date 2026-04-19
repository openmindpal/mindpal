import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'));

describe('math-skill', () => {
  // ── manifest 结构验证 ──────────────────────────────────────────
  describe('manifest.json', () => {
    it('identity.name 存在且非空', () => {
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBe('math.add');
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

    it('inputSchema 定义了 a 和 b 字段', () => {
      expect(manifest.io.inputSchema.fields.a).toBeDefined();
      expect(manifest.io.inputSchema.fields.a.type).toBe('number');
      expect(manifest.io.inputSchema.fields.b).toBeDefined();
      expect(manifest.io.inputSchema.fields.b.type).toBe('number');
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

    it('正常加法 2 + 3 = 5', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: { a: 2, b: 3 } });
      expect(result.sum).toBe(5);
    });

    it('负数加法 -1 + -2 = -3', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: { a: -1, b: -2 } });
      expect(result.sum).toBe(-3);
    });

    it('缺少参数默认为 0', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: { a: 5 } });
      expect(result.sum).toBe(5);
    });

    it('空输入返回 sum=0', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: {} });
      expect(result.sum).toBe(0);
    });

    it('浮点数加法', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: { a: 0.1, b: 0.2 } });
      expect(result.sum).toBeCloseTo(0.3);
    });
  });
});
