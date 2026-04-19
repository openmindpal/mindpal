import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(__dirname, '..');
const EXCLUDED = new Set(['__tests__', 'template-skill', 'node_modules']);
const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !EXCLUDED.has(d.name))
  .map(d => d.name);

// 确认已知的22个技能（除 template-skill 外）
const EXPECTED_SKILLS = [
  'bridge-send-skill',
  'collab-guard-skill',
  'collab-review-skill',
  'echo-skill',
  'exchange-poll-skill',
  'http-fetch-skill',
  'imap-poll-skill',
  'math-skill',
  'memory-graph-skill',
  'ocr-skill',
  'reflexion-skill',
  'scanned-pdf-skill',
  'schema-create-skill',
  'slack-send-skill',
  'sleep-skill',
  'sparse-search-skill',
  'speech-skill',
  'streaming-device-control',
  'tool-discovery-skill',
  'video-extract-skill',
  'vision-skill',
  'webhook-send-skill',
];

// streaming-device-control 使用非标准 manifest 格式，单独处理
const NON_STANDARD_MANIFEST = new Set(['streaming-device-control']);
const standardSkillDirs = skillDirs.filter(d => !NON_STANDARD_MANIFEST.has(d));

describe('All skills manifest validation', () => {
  it('应发现全部22个技能目录', () => {
    expect(skillDirs.sort()).toEqual(EXPECTED_SKILLS.sort());
  });

  // 标准 manifest 格式技能验证
  describe.each(standardSkillDirs)('skill "%s"', (skillName) => {
    const manifestPath = join(SKILLS_DIR, skillName, 'manifest.json');

    it('manifest.json 文件存在', () => {
      expect(existsSync(manifestPath)).toBe(true);
    });

    it('identity.name 存在且非空', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.identity).toBeDefined();
      expect(manifest.identity.name).toBeTruthy();
    });

    it('identity.version 符合 semver', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('contract 对象存在', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.contract).toBeDefined();
    });

    it('contract.riskLevel 为 low/medium/high', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.contract.riskLevel).toMatch(/^(low|medium|high)$/);
    });

    it('io.inputSchema 存在', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.io).toBeDefined();
      expect(manifest.io.inputSchema).toBeDefined();
    });

    it('io.outputSchema 存在', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.io).toBeDefined();
      expect(manifest.io.outputSchema).toBeDefined();
    });

    it('entry 字段存在', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.entry).toBeTruthy();
    });

    it('displayName 包含 zh-CN 和 en-US', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.displayName).toBeDefined();
      expect(manifest.displayName['zh-CN']).toBeTruthy();
      expect(manifest.displayName['en-US']).toBeTruthy();
    });
  });

  // 非标准 manifest 格式技能验证（streaming-device-control 等）
  describe.each([...NON_STANDARD_MANIFEST])('non-standard skill "%s"', (skillName) => {
    const manifestPath = join(SKILLS_DIR, skillName, 'manifest.json');

    it('manifest.json 文件存在', () => {
      expect(existsSync(manifestPath)).toBe(true);
    });

    it('name 和 version 存在', () => {
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.name).toBeTruthy();
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});
