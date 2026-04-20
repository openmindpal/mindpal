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

import { discoverEnabledTools } from "./agentContext";

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
