import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPool } from "./testHelpers";

const mockParseToolCallsFromOutput = vi.fn();
const mockResolveEffectiveToolRef = vi.fn();
const mockGetToolVersionByRef = vi.fn();
const mockGetToolDefinition = vi.fn();
const mockIsToolEnabled = vi.fn();

vi.mock("../lib/llm", () => ({
  invokeModelChat: vi.fn(),
  parseToolCallsFromOutput: (...args: any[]) => mockParseToolCallsFromOutput(...args),
}));

vi.mock("../modules/tools/resolve", () => ({
  resolveEffectiveToolRef: (...args: any[]) => mockResolveEffectiveToolRef(...args),
}));

vi.mock("../modules/tools/toolRepo", () => ({
  getToolVersionByRef: (...args: any[]) => mockGetToolVersionByRef(...args),
  getToolDefinition: (...args: any[]) => mockGetToolDefinition(...args),
}));

vi.mock("../modules/governance/toolGovernanceRepo", () => ({
  isToolEnabled: (...args: any[]) => mockIsToolEnabled(...args),
}));

vi.mock("../modules/agentContext", () => ({
  discoverEnabledTools: vi.fn(),
}));

vi.mock("../modules/semanticRouting/skillIntentRouter", () => ({
  routeByIntent: vi.fn(),
}));

import { parsePlanSuggestions } from "./planningKernel";

describe("planningKernel.parsePlanSuggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveEffectiveToolRef.mockResolvedValue("entity.create@1");
    mockGetToolVersionByRef.mockResolvedValue({ status: "released" });
    mockGetToolDefinition.mockResolvedValue({
      approvalRequired: false,
      riskLevel: "low",
    });
    mockIsToolEnabled.mockResolvedValue(true);
  });

  it("accepts unversioned planner suggestions when the enabled catalog contains a versioned toolRef", async () => {
    mockParseToolCallsFromOutput.mockReturnValue({
      toolCalls: [{ toolRef: "entity.create", inputDraft: { title: "demo" } }],
      parseErrorCount: 0,
    });

    const testPool = mockPool();
    const result = await parsePlanSuggestions({
      pool: testPool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      modelOutputText: "tool_call",
      enabledTools: [{ toolRef: "entity.create@1" } as Partial<import("../modules/agentContext").EnabledTool> as import("../modules/agentContext").EnabledTool],
      maxSteps: 3,
      actorRole: "executor",
      traceId: "trace-plan-unversioned",
    });

    expect(result.planSteps).toHaveLength(1);
    expect(result.planSteps[0]?.toolRef).toBe("entity.create@1");
    expect(result.filteredSuggestionCount).toBe(1);
    expect(result.droppedToolCalls).toHaveLength(0);
    expect(mockResolveEffectiveToolRef).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant_dev",
        spaceId: "space_dev",
        name: "entity.create",
      }),
    );
  });

  it("still drops suggestions whose tool name is not present in the enabled catalog", async () => {
    mockParseToolCallsFromOutput.mockReturnValue({
      toolCalls: [{ toolRef: "entity.delete", inputDraft: {} }],
      parseErrorCount: 0,
    });

    const result = await parsePlanSuggestions({
      pool: mockPool(),
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      modelOutputText: "tool_call",
      enabledTools: [{ toolRef: "entity.create@1" } as Partial<import("../modules/agentContext").EnabledTool> as import("../modules/agentContext").EnabledTool],
      maxSteps: 3,
    });

    expect(result.planSteps).toHaveLength(0);
    expect(result.filteredSuggestionCount).toBe(0);
    expect(result.droppedToolCalls).toEqual([
      { toolRef: "entity.delete", reason: "not_enabled", inputDraft: {} },
    ]);
    expect(mockResolveEffectiveToolRef).not.toHaveBeenCalled();
  });
});
