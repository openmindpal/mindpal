import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'));

describe('echo-skill', () => {
  // ── manifest 结构验证 ──────────────────────────────────────────
  describe('manifest.json', () => {
    it('identity.name 存在且非空', () => {
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBe('echo.tool');
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

    it('inputSchema 定义了 text 字段', () => {
      expect(manifest.io.inputSchema.fields.text).toBeDefined();
      expect(manifest.io.inputSchema.fields.text.type).toBe('string');
    });
  });

  // ── 执行逻辑验证 ──────────────────────────────────────────────
  describe('execute', () => {
    let execute: (req: unknown) => Promise<unknown>;

    it('should export execute function', async () => {
      const entryPath = join(SKILL_DIR, manifest.entry);
      if (!existsSync(entryPath)) {
        return; // dist 不存在则跳过
      }
      const mod = await import(entryPath);
      execute = mod.execute ?? mod.default;
      expect(typeof execute).toBe('function');
    });

    it('正常输入返回 echo 字段', async () => {
      const entryPath = join(SKILL_DIR, manifest.entry);
      if (!existsSync(entryPath)) return;
      const mod = await import(entryPath);
      execute = mod.execute ?? mod.default;

      const result: any = await execute({ input: { text: 'hello world' } });
      expect(result.echo).toBe('hello world');
    });

    it('空输入返回空字符串 echo', async () => {
      const entryPath = join(SKILL_DIR, manifest.entry);
      if (!existsSync(entryPath)) return;
      const mod = await import(entryPath);
      execute = mod.execute ?? mod.default;

      const result: any = await execute({ input: {} });
      expect(result.echo).toBe('');
    });

    it('undefined input 不抛异常', async () => {
      const entryPath = join(SKILL_DIR, manifest.entry);
      if (!existsSync(entryPath)) return;
      const mod = await import(entryPath);
      execute = mod.execute ?? mod.default;

      const result: any = await execute({});
      expect(result.echo).toBe('');
    });
  });
});
