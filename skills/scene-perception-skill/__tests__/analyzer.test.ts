import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SceneAnalyzer } from '../src/analyzer';
import { buildPrompt, IDENTIFY_PROMPT, AFFORDANCE_PROMPT } from '../src/prompts';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('SceneAnalyzer', () => {
  let analyzer: SceneAnalyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new SceneAnalyzer({
      endpoint: 'https://test.api/v1',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 5000,
      maxTokens: 1024,
    });
  });

  function mockVlmResponse(data: unknown) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(data) } }],
      }),
    });
  }

  describe('analyze', () => {
    it('returns structured scene analysis', async () => {
      const mockScene = {
        objects: [
          { name: 'cup', category: 'container', position: { x: 0.5, y: 0.8, z: 1.2 }, state: 'empty', affordances: ['graspable', 'pourable'], confidence: 0.95 },
        ],
        spatial_relations: [{ subject: 'cup', relation: 'on', object: 'table' }],
        scene_type: 'kitchen',
        hazards: [],
        summary: 'A kitchen counter with an empty cup on the table.',
      };
      mockVlmResponse(mockScene);

      const result = await analyzer.analyze('base64image');
      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].name).toBe('cup');
      expect(result.scene_type).toBe('kitchen');
    });

    it('includes context in prompt when provided', async () => {
      mockVlmResponse({ objects: [], spatial_relations: [], scene_type: 'unknown', hazards: [], summary: '' });
      await analyzer.analyze('img', 'I am looking for food');
      
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const textContent = callBody.messages[0].content[0].text;
      expect(textContent).toContain('I am looking for food');
    });
  });

  describe('identify', () => {
    it('finds target object', async () => {
      mockVlmResponse({
        found: true,
        object: { name: 'red_cup', category: 'container', position: null, state: 'empty', affordances: ['graspable'], confidence: 0.9 },
        alternatives: [],
        description: 'Red cup found on the left side of the table',
      });

      const result = await analyzer.identify('img', 'red cup');
      expect(result.found).toBe(true);
      expect(result.object?.name).toBe('red_cup');
    });
  });

  describe('querySpatial', () => {
    it('answers spatial question', async () => {
      mockVlmResponse({
        answer: 'Yes, the cup is on top of the table.',
        relations: [{ subject: 'cup', relation: 'on', object: 'table' }],
        confidence: 0.95,
      });

      const result = await analyzer.querySpatial('img', 'Is the cup on the table?');
      expect(result.answer).toContain('Yes');
      expect(result.relations).toHaveLength(1);
    });
  });

  describe('queryAffordance', () => {
    it('returns manipulation options', async () => {
      mockVlmResponse({
        object: 'cup',
        graspable: true,
        graspStrategy: 'side',
        movable: true,
        operations: ['pour', 'lift'],
        constraints: [],
        confidence: 0.9,
      });

      const result = await analyzer.queryAffordance('img', 'cup');
      expect(result.graspable).toBe(true);
      expect(result.graspStrategy).toBe('side');
      expect(result.operations).toContain('pour');
    });
  });

  describe('error handling', () => {
    it('throws on missing API key', async () => {
      const noKeyAnalyzer = new SceneAnalyzer({
        endpoint: 'https://test.api/v1',
        apiKey: '',
        model: 'test',
        timeoutMs: 5000,
        maxTokens: 1024,
      });
      await expect(noKeyAnalyzer.analyze('img')).rejects.toThrow('VLM API key not configured. Set via platform model management or SKILL_LLM_API_KEY environment variable.');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      });
      await expect(analyzer.analyze('img')).rejects.toThrow('VLM API error 429');
    });

    it('handles markdown-wrapped JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '```json\n{"objects":[],"spatial_relations":[],"scene_type":"unknown","hazards":[],"summary":"empty"}\n```' } }],
        }),
      });
      const result = await analyzer.analyze('img');
      expect(result.scene_type).toBe('unknown');
    });
  });
});

describe('Prompt Templates', () => {
  it('buildPrompt replaces variables', () => {
    const result = buildPrompt(IDENTIFY_PROMPT, { target: 'red_cup' });
    expect(result).toContain('red_cup');
    expect(result).not.toContain('{target}');
  });

  it('buildPrompt replaces multiple occurrences', () => {
    const result = buildPrompt(AFFORDANCE_PROMPT, { object: 'knife' });
    const count = (result.match(/knife/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2); // {object} appears multiple times
  });
});
