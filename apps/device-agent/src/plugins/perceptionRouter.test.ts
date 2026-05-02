import { describe, expect, it } from "vitest";
import { buildBackgroundBrowserArgs, getBrowserExecutableCandidates, resolveBackgroundBrowserLaunchPlan, summarizeBrowserTabs } from "./perceptionRouter";

describe("perceptionRouter background browser", () => {
  it("按优先级生成浏览器候选路径", () => {
    const candidates = getBrowserExecutableCandidates("win32", { DEVICE_AGENT_BROWSER_CHANNEL: "chrome", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } as NodeJS.ProcessEnv);
    expect(candidates[0]).toContain("Chrome");
    expect(candidates.some((item) => /msedge/i.test(item))).toBe(true);
  });

  it("构建后台浏览器启动参数", () => {
    const args = buildBackgroundBrowserArgs({ port: 9333, profileDir: "D:\\tmp\\mindpal-profile", headless: true, extraArgs: ["--lang=zh-CN"] });
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=D:\\tmp\\mindpal-profile");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--lang=zh-CN");
    expect(args.at(-1)).toBe("about:blank");
  });

  it("可解析后台浏览器启动计划", async () => {
    const plan = await resolveBackgroundBrowserLaunchPlan({
      DEVICE_AGENT_BROWSER_EXECUTABLE: "msedge",
      DEVICE_AGENT_BROWSER_PROFILE_DIR: "D:\\tmp\\mindpal-profile",
      DEVICE_AGENT_BROWSER_DEBUG_PORT: "9666",
      DEVICE_AGENT_BROWSER_HEADLESS: "false",
    } as NodeJS.ProcessEnv, "win32");

    expect(plan).toBeTruthy();
    expect(plan?.executablePath).toBe("msedge");
    expect(plan?.debugPort).toBe(9666);
    expect(plan?.profileDir).toBe("D:\\tmp\\mindpal-profile");
    expect(plan?.headless).toBe(false);
    expect(plan?.args).toContain("--remote-debugging-port=9666");
  });

  it("会汇总标签页并标记活动标签", () => {
    const tabs = summarizeBrowserTabs(
      [
        { url: "https://example.com", title: "Example" },
        { url: "https://www.doubao.com", title: "豆包" },
      ],
      1,
    );

    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ id: "tab-0", active: false, title: "Example" });
    expect(tabs[1]).toMatchObject({ id: "tab-1", active: true, title: "豆包" });
  });
});
