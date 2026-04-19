import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'));

describe('memory-graph-skill', () => {
  // ── manifest 结构验证 ──────────────────────────────────────────
  describe('manifest.json', () => {
    it('identity.name 存在且非空', () => {
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBe('memory.graph.query');
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

    it('inputSchema 定义了 currentSummary 和 candidates 字段', () => {
      expect(manifest.io.inputSchema.fields.currentSummary).toBeDefined();
      expect(manifest.io.inputSchema.fields.candidates).toBeDefined();
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

    it('空 currentSummary 返回空结果', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: { currentSummary: '', candidates: [] } });
      expect(result.relatedRuns).toEqual([]);
      expect(result.graphEdges).toEqual([]);
    });

    it('空 candidates 返回空结果', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({ input: { currentSummary: '任务摘要', candidates: [] } });
      expect(result.relatedRuns).toEqual([]);
      expect(result.graphEdges).toEqual([]);
    });

    it('相同文本返回高相似度', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({
        input: {
          currentSummary: '用户登录认证系统优化',
          candidates: [
            { runId: 'r1', summary: '用户登录认证系统优化', phase: 'done', createdAt: '2026-01-01' },
            { runId: 'r2', summary: '完全不相关的内容描述', phase: 'done', createdAt: '2026-01-02' },
          ],
          topK: 5,
          minSimilarity: 0.1,
        },
      });
      expect(result.relatedRuns.length).toBeGreaterThanOrEqual(1);
      expect(result.relatedRuns[0].runId).toBe('r1');
      expect(result.relatedRuns[0].similarity).toBeGreaterThan(0.5);
    });

    it('topK 限制生效', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const candidates = Array.from({ length: 10 }, (_, i) => ({
        runId: `r${i}`,
        summary: `任务摘要内容 ${i} 系统优化`,
      }));
      const result = await execute({
        input: {
          currentSummary: '任务摘要内容系统优化',
          candidates,
          topK: 3,
          minSimilarity: 0,
        },
      });
      expect(result.relatedRuns.length).toBeLessThanOrEqual(3);
    });

    it('graphEdges 与 relatedRuns 对应', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({
        input: {
          currentSummary: '数据库性能优化',
          candidates: [
            { runId: 'r1', summary: '数据库性能优化任务' },
          ],
          topK: 5,
          minSimilarity: 0,
        },
      });
      const fromCurrentEdges = result.graphEdges.filter((e: any) => e.from === 'current');
      expect(fromCurrentEdges.length).toBe(result.relatedRuns.length);
    });

    it('undefined input 不抛异常', async () => {
      const execute = await loadExecute();
      if (!execute) return;
      const result = await execute({});
      expect(result.relatedRuns).toEqual([]);
      expect(result.graphEdges).toEqual([]);
    });
  });
});
