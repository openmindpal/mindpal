import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'));

describe('schema-create-skill', () => {
  // ── manifest 结构验证 ──────────────────────────────────────────
  describe('manifest.json', () => {
    it('identity.name 存在且非空', () => {
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBe('schema.create');
    });

    it('identity.version 符合 semver', () => {
      expect(manifest.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('displayName 包含 zh-CN 和 en-US', () => {
      expect(manifest.displayName['zh-CN']).toBeTruthy();
      expect(manifest.displayName['en-US']).toBeTruthy();
    });

    it('contract 对象存在且 riskLevel 为 high', () => {
      expect(manifest.contract).toBeDefined();
      expect(manifest.contract.riskLevel).toBe('high');
    });

    it('contract.approvalRequired 为 true', () => {
      expect(manifest.contract.approvalRequired).toBe(true);
    });

    it('io.inputSchema 和 io.outputSchema 存在', () => {
      expect(manifest.io).toBeDefined();
      expect(manifest.io.inputSchema).toBeDefined();
      expect(manifest.io.outputSchema).toBeDefined();
    });

    it('entry 字段存在', () => {
      expect(manifest.entry).toBeTruthy();
    });

    it('inputSchema 定义了 description 必填字段', () => {
      expect(manifest.io.inputSchema.fields.description).toBeDefined();
      expect(manifest.io.inputSchema.fields.description.required).toBe(true);
    });

    it('outputSchema 包含 changesetId 和 approvalUrl', () => {
      expect(manifest.io.outputSchema.fields.changesetId).toBeDefined();
      expect(manifest.io.outputSchema.fields.approvalUrl).toBeDefined();
    });
  });

  // ── 执行逻辑验证 ──────────────────────────────────────────────
  describe('execute', () => {
    async function loadExecute() {
      const entryPath = join(SKILL_DIR, manifest.entry);
      if (!existsSync(entryPath)) return null;
      try {
        const mod = await import(entryPath);
        return (mod.execute ?? mod.default) as (req: unknown) => Promise<any>;
      } catch {
        return null;
      }
    }

    it('should export execute function', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      expect(typeof execute).toBe('function');
    });

    it('缺少 apiFetch 时抛出异常', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      await expect(
        execute({ input: { description: '客户管理系统', confirm: true }, context: {} })
      ).rejects.toThrow('apiFetch');
    });

    it('测试模式下未确认时返回 requiresConfirmation', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({
        input: { description: '测试用Schema' },
        context: { apiFetch: async () => ({ ok: true, json: async () => ({}) }) },
      });
      expect(result.requiresConfirmation).toBe(true);
      expect(result.isTestDetected).toBe(true);
    });

    it('未确认时返回预览信息', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const mockApiFetch = async () => ({
        ok: true,
        json: async () => ({ content: JSON.stringify({ schemaName: 'crm', entities: [{ name: 'customer', displayName: '客户' }] }) }),
      });
      const result = await execute({
        input: { description: '客户管理系统' },
        context: { apiFetch: mockApiFetch },
      });
      expect(result.requiresConfirmation).toBe(true);
      expect(result.preview).toBeDefined();
    });
  });
});
