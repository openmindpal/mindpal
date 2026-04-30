import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListToolDefinitions = vi.fn();
const mockGetLatestReleasedToolVersion = vi.fn();
const mockGetToolVersionByRef = vi.fn();
const mockResolveEffectiveToolRef = vi.fn();
const mockIsToolEnabled = vi.fn();

vi.mock("./tools/toolRepo", () => ({
  listToolDefinitions: (...args: any[]) => mockListToolDefinitions(...args),
  getLatestReleasedToolVersion: (...args: any[]) => mockGetLatestReleasedToolVersion(...args),
  getToolVersionByRef: (...args: any[]) => mockGetToolVersionByRef(...args),
}));

vi.mock("./tools/resolve", () => ({
  resolveEffectiveToolRef: (...args: any[]) => mockResolveEffectiveToolRef(...args),
}));

vi.mock("./governance/toolGovernanceRepo", () => ({
  isToolEnabled: (...args: any[]) => mockIsToolEnabled(...args),
}));

const mockPoolQuery = vi.fn();

import { discoverEnabledTools, interleavedRoundRobin } from "./agentContext";

describe("discoverEnabledTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({
      rows: [
        { rule_type: "hidden", match_field: "tag", match_pattern: "planner:hidden", effect: {}, enabled: true },
        { rule_type: "hidden", match_field: "prefix", match_pattern: "device.", effect: {}, enabled: true },
      ],
    });
    mockListToolDefinitions.mockResolvedValue([
      {
        name: "browser.navigate",
        displayName: { "zh-CN": "页面导航" },
        description: { "zh-CN": "打开网页" },
        riskLevel: "medium",
        priority: 8,
        category: "browser",
        tags: ["browser"],
      },
      {
        name: "desktop.mouse.click",
        displayName: { "zh-CN": "鼠标点击" },
        description: { "zh-CN": "点击坐标" },
        riskLevel: "medium",
        priority: 2,
        category: "desktop",
        tags: ["planner:hidden", "primitive"],
      },
      {
        name: "device.browser.open",
        displayName: { "zh-CN": "端侧浏览器打开" },
        description: { "zh-CN": "内部桥接能力" },
        riskLevel: "medium",
        priority: 9,
        category: "browser",
        tags: ["device"],
      },
    ]);
    mockResolveEffectiveToolRef.mockImplementation(async ({ name }: { name: string }) => `${name}@1`);
    mockIsToolEnabled.mockResolvedValue(true);
    mockGetToolVersionByRef.mockResolvedValue({
      toolRef: "mock@1",
      status: "released",
      inputSchema: { fields: {} },
    });
    mockGetLatestReleasedToolVersion.mockResolvedValue(null);
  });

  it("默认隐藏 planner:hidden 标签和 device.* 内部工具", async () => {
    const result = await discoverEnabledTools({
      pool: { query: mockPoolQuery } as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      locale: "zh-CN",
      skipCache: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["browser.navigate"]);
    expect(result.catalog).toContain("browser.navigate@1");
    expect(result.catalog).not.toContain("desktop.mouse.click");
    expect(result.catalog).not.toContain("device.browser.open");
  });

  it("显式包含隐藏工具时返回完整端侧工具集合", async () => {
    const result = await discoverEnabledTools({
      pool: { query: mockPoolQuery } as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      locale: "zh-CN",
      skipCache: true,
      includeHiddenTools: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "device.browser.open",
      "browser.navigate",
      "desktop.mouse.click",
    ]);
  });

  it("分类过滤时仍保持默认隐藏规则", async () => {
    const result = await discoverEnabledTools({
      pool: { query: mockPoolQuery } as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      locale: "zh-CN",
      category: "browser",
      skipCache: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["browser.navigate"]);
    expect(result.catalog).toContain("browser.navigate@1");
    expect(result.catalog).not.toContain("device.browser.open");
  });
});

describe("interleavedRoundRobin", () => {
  it("基本多类型：3 种类型各 2 条，输出交错排列", () => {
    const items = [
      { type: "A", score: 0.9, id: "a1" },
      { type: "A", score: 0.7, id: "a2" },
      { type: "B", score: 0.8, id: "b1" },
      { type: "B", score: 0.5, id: "b2" },
      { type: "C", score: 0.6, id: "c1" },
      { type: "C", score: 0.4, id: "c2" },
    ];
    const result = interleavedRoundRobin(items);
    // 第 1 轮：A(0.9), B(0.8), C(0.6)  第 2 轮：A(0.7), B(0.5), C(0.4)
    expect(result.map(r => r.id)).toEqual(["a1", "b1", "c1", "a2", "b2", "c2"]);
  });

  it("单一类型：5 条同类型按原始顺序输出", () => {
    const items = [
      { type: "X", score: 0.9, id: "1" },
      { type: "X", score: 0.8, id: "2" },
      { type: "X", score: 0.7, id: "3" },
      { type: "X", score: 0.6, id: "4" },
      { type: "X", score: 0.5, id: "5" },
    ];
    const result = interleavedRoundRobin(items);
    expect(result.map(r => r.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("空输入返回空数组", () => {
    expect(interleavedRoundRobin([])).toEqual([]);
  });

  it("每种类型恰好 1 条，按得分降序输出（仅第 1 轮）", () => {
    const items = [
      { type: "A", score: 0.3, id: "a" },
      { type: "B", score: 0.9, id: "b" },
      { type: "C", score: 0.6, id: "c" },
    ];
    const result = interleavedRoundRobin(items);
    // 按组最高分降序：B(0.9) > C(0.6) > A(0.3)
    expect(result.map(r => r.id)).toEqual(["b", "c", "a"]);
  });

  it("高分组在第 1 轮排在低分组前面", () => {
    const items = [
      { type: "low", score: 0.3, id: "lo1" },
      { type: "low", score: 0.2, id: "lo2" },
      { type: "high", score: 0.9, id: "hi1" },
      { type: "high", score: 0.8, id: "hi2" },
    ];
    const result = interleavedRoundRobin(items);
    // 第 1 轮：high(0.9), low(0.3)  第 2 轮：high(0.8), low(0.2)
    expect(result.map(r => r.id)).toEqual(["hi1", "lo1", "hi2", "lo2"]);
  });

  it("type 为 null/undefined 时归入默认 'memory' 分组", () => {
    const items = [
      { type: null, score: 0.5, id: "n1" },
      { type: undefined, score: 0.4, id: "n2" },
      { type: "fact", score: 0.8, id: "f1" },
    ];
    const result = interleavedRoundRobin(items);
    // 第 1 轮：fact(0.8), memory(0.5)  第 2 轮：memory(0.4)
    expect(result.map(r => r.id)).toEqual(["f1", "n1", "n2"]);
  });
});
