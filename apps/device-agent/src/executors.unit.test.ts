import { describe, expect, it, vi, beforeAll } from "vitest";
import { executeDeviceTool } from "@mindpal/device-agent-sdk";
import { setBuiltinToolPlugin } from "@mindpal/device-agent-sdk";
import builtinToolPlugin from "./plugins/builtinToolPlugin";

beforeAll(() => {
  setBuiltinToolPlugin(builtinToolPlugin);
});

describe("executeDeviceTool confirmation", () => {
  it("requires double confirmation when uiPolicy.confirmationMode=double", async () => {
    const confirmFn = vi.fn(async () => true);
    const out = await executeDeviceTool({
      cfg: { apiBase: "http://x", deviceToken: "t" },
      claim: {
        execution: { deviceExecutionId: "00000000-0000-0000-0000-000000000000", toolRef: "echo@1", input: { a: 1 } },
        requireUserPresence: true,
        policy: { allowedTools: ["echo"], uiPolicy: { confirmationMode: "double" } },
      },
      confirmFn,
    });
    expect(out.status).toBe("succeeded");
    expect(confirmFn).toHaveBeenCalledTimes(2);
    expect(String((confirmFn.mock.calls as unknown[][])[1]?.[0] ?? "")).toContain("确认码");
  });

  it("fails when second confirmation is denied", async () => {
    const confirmFn = vi.fn(async (q: string) => !q.includes("确认码"));
    const out = await executeDeviceTool({
      cfg: { apiBase: "http://x", deviceToken: "t" },
      claim: {
        execution: { deviceExecutionId: "00000000-0000-0000-0000-000000000000", toolRef: "echo@1", input: { a: 1 } },
        requireUserPresence: true,
        policy: { allowedTools: ["echo"], uiPolicy: { confirmationMode: "double" } },
      },
      confirmFn,
    });
    expect(out.status).toBe("failed");
    expect(out.errorCategory).toBe("user_denied");
  });
});

