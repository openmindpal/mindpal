import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'));

describe('ocr-skill', () => {
  // ── manifest 结构验证 ──────────────────────────────────────────
  describe('manifest.json', () => {
    it('identity.name 存在且非空', () => {
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBe('knowledge.extract.ocr');
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

    it('inputSchema 定义了 imageUrl 和 imageBase64 字段', () => {
      expect(manifest.io.inputSchema.fields.imageUrl).toBeDefined();
      expect(manifest.io.inputSchema.fields.imageBase64).toBeDefined();
    });

    it('outputSchema 包含 text 和 confidence', () => {
      expect(manifest.io.outputSchema.fields.text).toBeDefined();
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

    it('无图像数据返回错误提示', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: {} });
      expect(result.text).toBe('');
      expect(result.confidence).toBe(0);
      expect(result._error).toBeTruthy();
    });

    it('无 OCR/LLM 配置时降级返回错误', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      // 清除环境变量确保无 API 配置
      const saved = {
        ocr: process.env.SKILL_OCR_ENDPOINT,
        llm: process.env.SKILL_LLM_ENDPOINT,
        distill: process.env.DISTILL_LLM_ENDPOINT,
      };
      delete process.env.SKILL_OCR_ENDPOINT;
      delete process.env.SKILL_LLM_ENDPOINT;
      delete process.env.DISTILL_LLM_ENDPOINT;

      try {
        const result = await execute({ input: { imageUrl: 'https://example.com/img.png' } });
        expect(result.text).toBe('');
        expect(result.confidence).toBe(0);
        expect(result._error).toBeTruthy();
      } finally {
        if (saved.ocr !== undefined) process.env.SKILL_OCR_ENDPOINT = saved.ocr;
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
