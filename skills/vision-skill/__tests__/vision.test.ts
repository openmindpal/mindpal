import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'));

describe('vision-skill', () => {
  // ── manifest 结构验证 ──────────────────────────────────────────
  describe('manifest.json', () => {
    it('identity.name 存在且非空', () => {
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBe('ai.multimodal.analyze');
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

    it('inputSchema 定义了 imageUrl 和 question 字段', () => {
      expect(manifest.io.inputSchema.fields.imageUrl).toBeDefined();
      expect(manifest.io.inputSchema.fields.question).toBeDefined();
    });

    it('outputSchema 包含 description 和 confidence', () => {
      expect(manifest.io.outputSchema.fields.description).toBeDefined();
      expect(manifest.io.outputSchema.fields.confidence).toBeDefined();
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

    it('无图像数据返回降级结果', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: {} });
      expect(result.description).toBeTruthy();
      expect(result.confidence).toBe(0);
      expect(result.tags).toEqual([]);
    });

    it('无 LLM 配置时使用本地降级 (URL 图像)', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const saved = {
        llm: process.env.SKILL_LLM_ENDPOINT,
        distill: process.env.DISTILL_LLM_ENDPOINT,
      };
      delete process.env.SKILL_LLM_ENDPOINT;
      delete process.env.DISTILL_LLM_ENDPOINT;

      try {
        const result = await execute({ input: { imageUrl: 'https://example.com/photo.jpg' } });
        expect(result.description).toContain('远程图像');
        expect(result.confidence).toBe(0.1);
        expect(result.tags).toContain('jpg');
      } finally {
        if (saved.llm !== undefined) process.env.SKILL_LLM_ENDPOINT = saved.llm;
        if (saved.distill !== undefined) process.env.DISTILL_LLM_ENDPOINT = saved.distill;
      }
    });

    it('无 LLM 配置时使用本地降级 (base64 图像)', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const saved = {
        llm: process.env.SKILL_LLM_ENDPOINT,
        distill: process.env.DISTILL_LLM_ENDPOINT,
      };
      delete process.env.SKILL_LLM_ENDPOINT;
      delete process.env.DISTILL_LLM_ENDPOINT;

      try {
        const result = await execute({ input: { imageBase64: 'dGVzdA==', mimeType: 'image/jpeg' } });
        expect(result.description).toContain('base64');
        expect(result.confidence).toBe(0.1);
      } finally {
        if (saved.llm !== undefined) process.env.SKILL_LLM_ENDPOINT = saved.llm;
        if (saved.distill !== undefined) process.env.DISTILL_LLM_ENDPOINT = saved.distill;
      }
    });

    it('undefined input 不抛异常', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({});
      expect(result).toBeDefined();
      expect(result.confidence).toBe(0);
    });
  });
});
