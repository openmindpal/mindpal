import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ToolExecutionContext } from "@mindpal/device-agent-sdk";

const {
  spawnMock,
  spawnSyncMock,
  apiPostJsonMock,
  readFileMock,
  captureScreenMock,
  cleanupCaptureMock,
  ocrScreenMock,
  findTextInOcrResultsMock,
  clickMouseMock,
  localTypeTextMock,
  pressComboMock,
  localScrollMock,
  routerPerceiveMock,
  locateAndActMock,
  browserDomNavigateMock,
  browserDomSessionStatusMock,
  browserDomListTabsMock,
  browserDomNewTabMock,
  browserDomSwitchTabMock,
  browserDomCloseTabMock,
  browserDomScreenshotMock,
  browserDomWaitForMock,
  browserDomExtractMock,
  browserDomEvaluateMock,
  initPerceptionProvidersMock,
  getActiveProviderNameMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  apiPostJsonMock: vi.fn(),
  readFileMock: vi.fn(),
  captureScreenMock: vi.fn(),
  cleanupCaptureMock: vi.fn(),
  ocrScreenMock: vi.fn(),
  findTextInOcrResultsMock: vi.fn(),
  clickMouseMock: vi.fn(),
  localTypeTextMock: vi.fn(),
  pressComboMock: vi.fn(),
  localScrollMock: vi.fn(),
  routerPerceiveMock: vi.fn(),
  locateAndActMock: vi.fn(),
  browserDomNavigateMock: vi.fn(),
  browserDomSessionStatusMock: vi.fn(),
  browserDomListTabsMock: vi.fn(),
  browserDomNewTabMock: vi.fn(),
  browserDomSwitchTabMock: vi.fn(),
  browserDomCloseTabMock: vi.fn(),
  browserDomScreenshotMock: vi.fn(),
  browserDomWaitForMock: vi.fn(),
  browserDomExtractMock: vi.fn(),
  browserDomEvaluateMock: vi.fn(),
  initPerceptionProvidersMock: vi.fn(),
  getActiveProviderNameMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  default: {
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  },
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: readFileMock,
  },
  readFile: readFileMock,
}));

vi.mock("@mindpal/device-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, apiPostJson: apiPostJsonMock };
});

vi.mock("../plugins/localVision", () => ({
  captureScreen: captureScreenMock,
  cleanupCapture: cleanupCaptureMock,
  ocrScreen: ocrScreenMock,
  findTextInOcrResults: findTextInOcrResultsMock,
  clickMouse: clickMouseMock,
  typeText: localTypeTextMock,
  pressKey: vi.fn(),
  pressCombo: pressComboMock,
  scroll: localScrollMock,
  moveMouse: vi.fn(),
}));

vi.mock("../plugins/perceptionRouter", () => ({
  perceive: routerPerceiveMock,
  locateAndAct: locateAndActMock,
  locateElement: vi.fn(),
  browserDomNavigate: browserDomNavigateMock,
  browserDomSessionStatus: browserDomSessionStatusMock,
  browserDomListTabs: browserDomListTabsMock,
  browserDomNewTab: browserDomNewTabMock,
  browserDomSwitchTab: browserDomSwitchTabMock,
  browserDomCloseTab: browserDomCloseTabMock,
  browserDomScreenshot: browserDomScreenshotMock,
  browserDomWaitFor: browserDomWaitForMock,
  browserDomExtract: browserDomExtractMock,
  browserDomEvaluate: browserDomEvaluateMock,
  initPerceptionProviders: initPerceptionProvidersMock,
  getActiveProviderName: getActiveProviderNameMock,
}));

import desktopPlugin from "../plugins/desktopPlugin";

type SpawnResult = {
  code?: number;
  stdout?: string;
  stderr?: string;
};

function queueSpawnResults(results: SpawnResult[]) {
  spawnMock.mockImplementation(() => {
    const next = results.shift() ?? {};
    const proc = new EventEmitter() as any;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    queueMicrotask(() => {
      if (next.stdout) proc.stdout.write(next.stdout);
      proc.stdout.end();
      if (next.stderr) proc.stderr.write(next.stderr);
      proc.stderr.end();
      proc.emit("exit", next.code ?? 0);
    });
    return proc;
  });
}

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function makeCtx(toolName: string, input: Record<string, unknown> = {}, extra?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    cfg: { apiBase: "http://127.0.0.1:9600", deviceToken: "tok" },
    execution: { deviceExecutionId: "exec-1", toolRef: `${toolName}@1`, input },
    toolName,
    input,
    policy: {
      clipboardPolicy: { allowRead: true, allowWrite: true, maxTextLength: 4096 },
    },
    requireUserPresence: true,
    confirmFn: async () => true,
    ...extra,
  };
}

const originalPlatform = process.platform;
initPerceptionProvidersMock.mockResolvedValue(undefined);
getActiveProviderNameMock.mockReturnValue("mock-provider");

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  apiPostJsonMock.mockReset();
  readFileMock.mockReset();
  captureScreenMock.mockReset();
  cleanupCaptureMock.mockReset();
  ocrScreenMock.mockReset();
  findTextInOcrResultsMock.mockReset();
  clickMouseMock.mockReset();
  localTypeTextMock.mockReset();
  pressComboMock.mockReset();
  localScrollMock.mockReset();
  routerPerceiveMock.mockReset();
  locateAndActMock.mockReset();
  browserDomNavigateMock.mockReset();
  browserDomSessionStatusMock.mockReset();
  browserDomListTabsMock.mockReset();
  browserDomNewTabMock.mockReset();
  browserDomSwitchTabMock.mockReset();
  browserDomCloseTabMock.mockReset();
  browserDomScreenshotMock.mockReset();
  browserDomWaitForMock.mockReset();
  browserDomExtractMock.mockReset();
  browserDomEvaluateMock.mockReset();
  initPerceptionProvidersMock.mockReset();
  getActiveProviderNameMock.mockReset();
  initPerceptionProvidersMock.mockResolvedValue(undefined);
  getActiveProviderNameMock.mockReturnValue("mock-provider");
  setPlatform(originalPlatform);
});

describe("desktopPlugin simulated cross-platform branches", () => {
  it("macOS window.focus reports backend unavailable when osascript is missing", async () => {
    setPlatform("darwin");
    queueSpawnResults([
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.focus", { windowId: "42" }),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("device_not_ready");
    expect(result.outputDigest?.reason).toBe("window_backend_unavailable");
    expect(result.outputDigest?.platform).toBe("darwin");
    expect(result.outputDigest?.accessibilityRequired).toBe(true);
    expect(result.outputDigest?.missingCommands).toContain("osascript");
  });

  it("macOS window.list returns parsed windows when osascript backend is available", async () => {
    setPlatform("darwin");
    queueSpawnResults([
      { code: 0, stdout: "/usr/bin/osascript\n" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
      { code: 0, stdout: "/usr/bin/osascript\n" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
      {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "101",
            title: "Preview",
            appName: "Preview",
            bounds: { x: 10, y: 20, width: 800, height: 600 },
          },
        ]),
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.list", {}),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.windowBackend).toBe("osascript+jxa");
    expect(result.outputDigest?.count).toBe(1);
    expect(result.outputDigest?.windows?.[0]).toEqual({
      id: "101",
      title: "Preview",
      appName: "Preview",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
  });

  it("macOS window.focus succeeds when osascript backend can locate the window", async () => {
    setPlatform("darwin");
    queueSpawnResults([
      { code: 0, stdout: "/usr/bin/osascript\n" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
      { code: 0, stdout: "/usr/bin/osascript\n" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
      {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "101",
            title: "Preview",
            appName: "Preview",
            bounds: { x: 10, y: 20, width: 800, height: 600 },
          },
        ]),
      },
      { code: 0, stdout: "ok" },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.focus", { windowId: "101" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.windowBackend).toBe("osascript+jxa");
    expect(result.outputDigest?.windowId).toBe("101");
    expect(result.outputDigest?.appName).toBe("Preview");
  });

  it("linux file.dialog reports missing GUI dialog backend", async () => {
    setPlatform("linux");
    queueSpawnResults([
      { code: 0, stdout: "/usr/bin/wmctrl\n" },
      { code: 0, stdout: "/usr/bin/xdotool\n" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.file.dialog", { type: "open" }),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("device_not_ready");
    expect(result.outputDigest?.reason).toBe("file_dialog_backend_unavailable");
    expect(result.outputDigest?.platform).toBe("linux");
    expect(result.outputDigest?.missingCommands).toContain("zenity|kdialog");
  });

  it("macOS file.dialog returns selected path when osascript backend succeeds", async () => {
    setPlatform("darwin");
    queueSpawnResults([
      { code: 0, stdout: "/usr/bin/osascript\n" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
      { code: 0, stdout: "/usr/bin/osascript\n" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
      {
        code: 0,
        stdout: JSON.stringify({ selected: true, paths: ["/Users/demo/Documents/report.txt"] }),
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.file.dialog", { type: "open", title: "Pick a file" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.fileDialogBackend).toBe("osascript+jxa");
    expect(result.outputDigest?.selected).toBe(true);
    expect(result.outputDigest?.paths).toEqual(["/Users/demo/Documents/report.txt"]);
  });

  it("linux window.list reports backend unavailable when wmctrl and xdotool are both missing", async () => {
    setPlatform("linux");
    queueSpawnResults([
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 0, stdout: "/usr/bin/zenity\n" },
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 0, stdout: "/usr/bin/zenity\n" },
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 0, stdout: "/usr/bin/zenity\n" },
      { code: 1, stderr: "not found" },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.list", {}),
    );

    expect(result.status).toBe("failed");
    expect(result.outputDigest?.reason).toBe("window_list_failed");
    expect(result.outputDigest?.windowBackend).toBeNull();
    expect(result.outputDigest?.missingCommands).toContain("wmctrl|xdotool");
  });

  it("linux window.list returns parsed windows when wmctrl backend is available", async () => {
    setPlatform("linux");
    queueSpawnResults([
      { code: 0, stdout: "/usr/bin/wmctrl\n" },
      { code: 0, stdout: "/usr/bin/xdotool\n" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 0, stdout: "/usr/bin/zenity\n" },
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "/usr/bin/wmctrl\n" },
      { code: 0, stdout: "/usr/bin/xdotool\n" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 0, stdout: "/usr/bin/zenity\n" },
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "0x01200007  0  777  10  20  800  600  org.example.App  host  Demo Window\n" },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.list", {}),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.windowBackend).toBe("wmctrl");
    expect(result.outputDigest?.count).toBe(1);
    expect(result.outputDigest?.windows?.[0]).toEqual({
      id: "0x01200007",
      title: "Demo Window",
      appName: "org.example.App",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
  });

  it("linux window.resize uses wmctrl backend when available", async () => {
    setPlatform("linux");
    queueSpawnResults([
      { code: 0, stdout: "/usr/bin/wmctrl\n" },
      { code: 0, stdout: "/usr/bin/xdotool\n" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "/usr/bin/wmctrl\n" },
      { code: 0, stdout: "/usr/bin/xdotool\n" },
      { code: 0, stdout: "/usr/bin/scrot\n" },
      { code: 1, stderr: "not found" },
      { code: 1, stderr: "not found" },
      { code: 0, stdout: "0x01200007  0  777  10  20  800  600  org.example.App  host  Demo Window\n" },
      { code: 0, stdout: "" },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.resize", { windowId: "0x01200007", x: 100, y: 120, width: 900, height: 700 }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.windowBackend).toBe("wmctrl");
    expect(result.outputDigest?.windowId).toBe("0x01200007");
    expect(spawnMock).toHaveBeenLastCalledWith(
      "wmctrl",
      ["-ir", "0x01200007", "-e", "0,100,120,900,700"],
      expect.any(Object),
    );
  });

  it("windows window.list returns parsed windows from PowerShell", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "65552",
            title: "Calculator",
            appName: "CalculatorApp",
            bounds: null,
          },
        ]),
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.list", {}),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.platform).toBe("win32");
    expect(result.outputDigest?.windowBackend).toBe("user32+powershell");
    expect(result.outputDigest?.count).toBe(1);
    expect(result.outputDigest?.windows?.[0]).toEqual({
      id: "65552",
      title: "Calculator",
      appName: "CalculatorApp",
      bounds: null,
    });
    expect(spawnMock).toHaveBeenLastCalledWith(
      "powershell",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]),
      expect.any(Object),
    );
  });

  it("windows file.dialog returns selected path from PowerShell dialog", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: JSON.stringify({
          selected: true,
          paths: ["C:\\Users\\demo\\Documents\\report.txt"],
        }),
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.file.dialog", {
        type: "open",
        title: "Pick a file",
        filters: [{ name: "Text", extensions: ["txt"] }],
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.fileDialogBackend).toBe("powershell");
    expect(result.outputDigest?.selected).toBe(true);
    expect(result.outputDigest?.paths).toEqual(["C:\\Users\\demo\\Documents\\report.txt"]);
  });

  it("windows window.focus succeeds and issues foreground command via PowerShell", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "65552",
            title: "Calculator",
            appName: "CalculatorApp",
            bounds: null,
          },
        ]),
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.focus", { windowId: "65552" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.windowBackend).toBe("user32+powershell");
    expect(result.outputDigest?.windowId).toBe("65552");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]),
      { stdio: "ignore" },
    );
  });

  it("windows window.resize succeeds and issues MoveWindow via PowerShell", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "65552",
            title: "Calculator",
            appName: "CalculatorApp",
            bounds: { x: 40, y: 60, width: 700, height: 500 },
          },
        ]),
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.window.resize", { windowId: "65552", x: 80, y: 120, width: 900, height: 640 }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.windowBackend).toBe("user32+powershell");
    expect(result.outputDigest?.windowId).toBe("65552");
    expect(result.outputDigest?.width).toBe(900);
    expect(result.outputDigest?.height).toBe(640);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]),
      { stdio: "ignore" },
    );
  });

  it("windows clipboard.get returns text and formats from PowerShell", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: JSON.stringify({
          text: "hello from clipboard",
          hasImage: false,
          formats: ["text/plain"],
        }),
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.clipboard.get", {}),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.success).toBe(true);
    expect(result.outputDigest?.text).toBe("hello from clipboard");
    expect(result.outputDigest?.formats).toEqual(["text/plain"]);
    expect(result.outputDigest?.length).toBe("hello from clipboard".length);
  });

  it("windows clipboard.set writes text through PowerShell", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: "",
      },
    ]);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.clipboard.set", { text: "copied text" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.success).toBe(true);
    expect(result.outputDigest?.length).toBe("copied text".length);
    expect(result.outputDigest?.wroteImage).toBe(false);
    expect(spawnMock).toHaveBeenLastCalledWith(
      "powershell",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      { stdio: "ignore" },
    );
  });

  it("windows screen.capture uploads region screenshot evidence", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: "320x200",
      },
    ]);
    readFileMock.mockResolvedValue(Buffer.from("png-bytes"));
    cleanupCaptureMock.mockResolvedValue(undefined);
    apiPostJsonMock.mockResolvedValue({
      status: 200,
      json: { artifactId: "artifact-1", evidenceRef: "evidence-1" },
    });

    const result = await desktopPlugin.execute(
      makeCtx("desktop.screen.capture", { x: 10, y: 20, width: 320, height: 200 }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.artifactId).toBe("artifact-1");
    expect(result.outputDigest?.width).toBe(320);
    expect(result.outputDigest?.height).toBe(200);
    expect(result.outputDigest?.source).toBe("captureRegion");
    expect(apiPostJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/device-agent/evidence/upload",
        body: expect.objectContaining({
          deviceExecutionId: "exec-1",
          contentType: "image/png",
          format: "png",
        }),
      }),
    );
  });

  it("macOS screen.capture uses screencapture backend for region capture", async () => {
    setPlatform("darwin");
    queueSpawnResults([
      { code: 0, stdout: "/usr/bin/osascript\n" },
      { code: 0, stdout: "/usr/bin/screencapture\n" },
      { code: 0, stdout: "" },
    ]);
    readFileMock.mockResolvedValue(Buffer.from("darwin-png"));
    cleanupCaptureMock.mockResolvedValue(undefined);
    apiPostJsonMock.mockResolvedValue({
      status: 200,
      json: { artifactId: "artifact-darwin", evidenceRef: "evidence-darwin" },
    });

    const result = await desktopPlugin.execute(
      makeCtx("desktop.screen.capture", { x: 15, y: 25, width: 640, height: 360 }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.source).toBe("captureRegion");
    expect(result.outputDigest?.width).toBe(640);
    expect(result.outputDigest?.height).toBe(360);
    expect(spawnMock).toHaveBeenLastCalledWith(
      "screencapture",
      expect.arrayContaining(["-x", "-R", "15,25,640,360"]),
      expect.any(Object),
    );
  });

  it("windows screen.ocr returns OCR text extracted from captured region", async () => {
    setPlatform("win32");
    queueSpawnResults([
      {
        code: 0,
        stdout: "300x120",
      },
    ]);
    ocrScreenMock.mockResolvedValue([
      {
        text: "Hello",
        bbox: { x: 1, y: 2, width: 50, height: 20 },
        confidence: 0.98,
      },
      {
        text: "World",
        bbox: { x: 60, y: 2, width: 55, height: 20 },
        confidence: 0.97,
      },
    ]);
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("desktop.screen.ocr", { x: 5, y: 6, width: 300, height: 120 }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.text).toBe("Hello\nWorld");
    expect(result.outputDigest?.width).toBe(300);
    expect(result.outputDigest?.height).toBe(120);
    expect(result.outputDigest?.blocks).toHaveLength(2);
  });
});

describe("desktopPlugin simulated browser automation branches", () => {
  it("browser.navigate succeeds through DOM driver when domain is allowed", async () => {
    browserDomNavigateMock.mockResolvedValue({
      ok: true,
      url: "https://example.com/dashboard",
      title: "Dashboard",
      readyState: "complete",
      source: "playwright",
    });

    const result = await desktopPlugin.execute(
      makeCtx(
        "browser.navigate",
        { url: "https://example.com/dashboard", timeout: 5000 },
        {
          policy: {
            networkPolicy: { allowedDomains: ["example.com"] },
          } as any,
        },
      ),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.url).toBe("https://example.com/dashboard");
    expect(result.outputDigest?.title).toBe("Dashboard");
    expect(result.outputDigest?.perceptionSource).toBe("playwright");
    expect(result.outputDigest?.silentCapable).toBe(true);
  });

  it("browser.click succeeds through perception router and returns post-click text sample", async () => {
    locateAndActMock.mockResolvedValue({
      ok: true,
      source: "playwright",
      usedMouseSimulation: false,
      element: {
        bbox: { x: 120, y: 240, w: 80, h: 24 },
        confidence: 0.93,
      },
    });
    routerPerceiveMock.mockResolvedValue({
      elements: [{ text: "Settings" }, { text: "Saved" }],
    });

    const result = await desktopPlugin.execute(
      makeCtx("browser.click", { selector: "Save" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.clickedText).toBe("Save");
    expect(result.outputDigest?.perceptionSource).toBe("playwright");
    expect(result.outputDigest?.screenTextsAfterClick).toEqual(["Settings", "Saved"]);
  });

  it("browser.click falls back to OCR match when router cannot locate target", async () => {
    locateAndActMock.mockResolvedValue(null);
    captureScreenMock
      .mockResolvedValueOnce({ filePath: "screen-click-before.png", width: 320, height: 180 })
      .mockResolvedValueOnce({ filePath: "screen-click-after.png", width: 320, height: 180 });
    ocrScreenMock
      .mockResolvedValueOnce([{ text: "Continue", bbox: { x: 120, y: 60, w: 80, h: 24 }, confidence: 0.91 }])
      .mockResolvedValueOnce([{ text: "Step 2", bbox: { x: 20, y: 20, w: 60, h: 20 }, confidence: 0.94 }]);
    findTextInOcrResultsMock.mockReturnValue({ text: "Continue", x: 160, y: 72, confidence: 0.91 });
    clickMouseMock.mockResolvedValue(undefined);
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("browser.click", { selector: "Continue" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.perceptionSource).toBe("local_ocr_fallback");
    expect(result.outputDigest?.position).toEqual({ x: 160, y: 72 });
    expect(clickMouseMock).toHaveBeenCalledWith(160, 72, "left");
  });

  it("browser.waitFor reports timeout when DOM driver returns timeout", async () => {
    browserDomWaitForMock.mockResolvedValue({
      ok: false,
      found: false,
      waitedMs: 1500,
      matchedText: "Checkout",
      pageTextSample: ["Cart", "Payment"],
      source: "playwright",
      error: "timeout waiting for selector",
    });

    const result = await desktopPlugin.execute(
      makeCtx("browser.waitFor", { selector: "#checkout", timeout: 1500 }),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("timeout");
    expect(result.outputDigest?.perceptionSource).toBe("playwright");
    expect(result.outputDigest?.visibleTexts).toEqual(["Cart", "Payment"]);
  });

  it("browser.waitFor succeeds through OCR fallback when expected text appears", async () => {
    browserDomWaitForMock.mockResolvedValue(null);
    captureScreenMock.mockResolvedValue({ filePath: "screen-wait.png", width: 300, height: 150 });
    ocrScreenMock.mockResolvedValue([{ text: "Checkout", bbox: { x: 80, y: 40, w: 90, h: 22 }, confidence: 0.95 }]);
    findTextInOcrResultsMock.mockReturnValue({ text: "Checkout", x: 125, y: 51, confidence: 0.95 });
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("browser.waitFor", { text: "Checkout", timeout: 1500 }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.found).toBe(true);
    expect(result.outputDigest?.matchedText).toBe("Checkout");
  });

  it("browser.type focuses via router, clears, and types text", async () => {
    locateAndActMock.mockResolvedValue({
      ok: true,
      source: "playwright",
      usedMouseSimulation: false,
      element: {
        bbox: { x: 100, y: 200, w: 120, h: 28 },
        confidence: 0.96,
      },
    });
    localTypeTextMock.mockResolvedValue(undefined);
    pressComboMock.mockResolvedValue(undefined);
    captureScreenMock.mockResolvedValue({ filePath: "screen-after-type.png", width: 200, height: 80 });
    ocrScreenMock.mockResolvedValue([{ text: "new value", bbox: { x: 10, y: 10, w: 60, h: 20 }, confidence: 0.9 }]);
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("browser.type", { selector: "Search", text: "new value", clear: true }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.focused).toBe(true);
    expect(String(result.outputDigest?.focusStrategy)).toContain("perception_router");
    expect(result.outputDigest?.textLength).toBe("new value".length);
    expect(pressComboMock).toHaveBeenCalledWith(["ctrl", "a"]);
    expect(localTypeTextMock).toHaveBeenCalledWith("new value");
  });

  it("browser.type returns element_not_found when selector cannot be matched", async () => {
    locateAndActMock.mockResolvedValue(null);
    captureScreenMock.mockResolvedValue({ filePath: "screen-before-type.png", width: 300, height: 100 });
    ocrScreenMock.mockResolvedValue([{ text: "Username", bbox: { x: 5, y: 5, w: 80, h: 20 }, confidence: 0.9 }]);
    findTextInOcrResultsMock.mockReturnValue(null);
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("browser.type", { selector: "Password", text: "secret" }),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("element_not_found");
    expect(result.outputDigest?.reason).toBe("selector_text_not_found");
    expect(result.outputDigest?.targetText).toBe("Password");
  });

  it("browser.extract returns structured DOM extraction results", async () => {
    captureScreenMock.mockResolvedValue({ filePath: "screen.png", width: 100, height: 80 });
    ocrScreenMock.mockResolvedValue([]);
    cleanupCaptureMock.mockResolvedValue(undefined);
    browserDomExtractMock.mockResolvedValue({
      ok: true,
      value: "Alpha",
      values: ["Alpha", "Beta"],
      count: 2,
      elements: [{ text: "Alpha" }, { text: "Beta" }],
      source: "playwright",
    });

    const result = await desktopPlugin.execute(
      makeCtx("browser.extract", { selector: ".item", multiple: true }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.count).toBe(2);
    expect(result.outputDigest?.values).toEqual(["Alpha", "Beta"]);
    expect(result.outputDigest?.perceptionSource).toBe("playwright");
  });

  it("browser.extract falls back to OCR filtering when selector is absent", async () => {
    captureScreenMock.mockResolvedValue({ filePath: "screen-extract.png", width: 320, height: 180 });
    ocrScreenMock.mockResolvedValue([
      { text: "Order #1001", bbox: { x: 10, y: 10, w: 100, h: 20 }, confidence: 0.92 },
      { text: "Order #1002", bbox: { x: 10, y: 40, w: 100, h: 20 }, confidence: 0.91 },
      { text: "Total", bbox: { x: 10, y: 70, w: 60, h: 20 }, confidence: 0.9 },
    ]);
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("browser.extract", { filter: "Order", multiple: true }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.count).toBe(2);
    expect(result.outputDigest?.value).toBe("Order #1001\nOrder #1002");
    expect(result.outputDigest?.values).toEqual(["Order #1001", "Order #1002"]);
  });

  it("browser.evaluate reports unsupported_tool when no browser driver is available", async () => {
    browserDomEvaluateMock.mockResolvedValue(null);

    const result = await desktopPlugin.execute(
      makeCtx("browser.evaluate", { script: "() => document.title" }),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("unsupported_tool");
    expect(result.outputDigest?.reason).toContain("browser.evaluate requires a browser driver");
  });

  it("browser.select clicks matched option and returns selection context", async () => {
    captureScreenMock
      .mockResolvedValueOnce({ filePath: "screen-select-before.png", width: 200, height: 100 })
      .mockResolvedValueOnce({ filePath: "screen-select-after.png", width: 200, height: 100 });
    ocrScreenMock
      .mockResolvedValueOnce([{ text: "Option A", bbox: { x: 40, y: 50, w: 70, h: 18 }, confidence: 0.95 }])
      .mockResolvedValueOnce([{ text: "Selected: Option A", bbox: { x: 20, y: 20, w: 120, h: 20 }, confidence: 0.95 }]);
    findTextInOcrResultsMock.mockReturnValue({ text: "Option A", x: 75, y: 59, confidence: 0.95 });
    clickMouseMock.mockResolvedValue(undefined);
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("browser.select", { label: "Option A" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.selectedValue).toBe("Option A");
    expect(result.outputDigest?.position).toEqual({ x: 75, y: 59 });
    expect(clickMouseMock).toHaveBeenCalledWith(75, 59);
  });

  it("browser.scroll scrolls page and returns updated visible texts", async () => {
    localScrollMock.mockResolvedValue(undefined);
    captureScreenMock.mockResolvedValue({ filePath: "screen-scroll-after.png", width: 300, height: 200 });
    ocrScreenMock.mockResolvedValue([
      { text: "Row 10", bbox: { x: 10, y: 10, w: 50, h: 20 }, confidence: 0.92 },
      { text: "Row 11", bbox: { x: 10, y: 35, w: 50, h: 20 }, confidence: 0.92 },
    ]);
    cleanupCaptureMock.mockResolvedValue(undefined);

    const result = await desktopPlugin.execute(
      makeCtx("browser.scroll", { y: 240 }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.direction).toBe("down");
    expect(result.outputDigest?.clicks).toBe(3);
    expect(result.outputDigest?.visibleTextsAfterScroll).toEqual(["Row 10", "Row 11"]);
    expect(localScrollMock).toHaveBeenCalledWith("down", 3);
  });

  it("browser.session.status returns connected session details", async () => {
    browserDomSessionStatusMock.mockResolvedValue({
      ok: true,
      connected: true,
      owned: true,
      browserName: "chromium",
      activeTabId: "tab-1",
      activeUrl: "https://example.com",
      activeTitle: "Example",
      tabCount: 2,
      tabs: [{ id: "tab-1", title: "Example", url: "https://example.com" }],
      source: "playwright",
    });

    const result = await desktopPlugin.execute(
      makeCtx("browser.session.status", {}),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.connected).toBe(true);
    expect(result.outputDigest?.tabCount).toBe(2);
    expect(result.outputDigest?.perceptionSource).toBe("playwright");
  });

  it("browser.tab.list reports unsupported_tool when tab driver is unavailable", async () => {
    browserDomListTabsMock.mockResolvedValue(null);

    const result = await desktopPlugin.execute(
      makeCtx("browser.tab.list", {}),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("unsupported_tool");
    expect(result.outputDigest?.reason).toBe("browser_tab_management_requires_browser_driver");
  });

  it("browser.tab.new creates a new tab through browser driver", async () => {
    browserDomNewTabMock.mockResolvedValue({
      id: "tab-2",
      url: "https://example.com/new",
      title: "New Tab",
      source: "playwright",
    });

    const result = await desktopPlugin.execute(
      makeCtx("browser.tab.new", { url: "https://example.com/new", activate: true }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.tabId).toBe("tab-2");
    expect(result.outputDigest?.url).toBe("https://example.com/new");
  });

  it("browser.tab.switch switches active tab through browser driver", async () => {
    browserDomSwitchTabMock.mockResolvedValue({
      id: "tab-2",
      url: "https://example.com/new",
      title: "New Tab",
      source: "playwright",
    });

    const result = await desktopPlugin.execute(
      makeCtx("browser.tab.switch", { tabId: "tab-2" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.tabId).toBe("tab-2");
    expect(result.outputDigest?.perceptionSource).toBe("playwright");
  });

  it("browser.tab.close returns remaining tabs after close", async () => {
    browserDomCloseTabMock.mockResolvedValue({
      ok: true,
      closedTabId: "tab-2",
      remainingTabs: 1,
      activeTabId: "tab-1",
      source: "playwright",
    });

    const result = await desktopPlugin.execute(
      makeCtx("browser.tab.close", { tabId: "tab-2" }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.closedTabId).toBe("tab-2");
    expect(result.outputDigest?.remainingTabs).toBe(1);
  });

  it("browser.screenshot uploads DOM screenshot evidence when driver succeeds", async () => {
    browserDomScreenshotMock.mockResolvedValue({
      ok: true,
      contentBase64: "cG5nLWRhdGE=",
      width: 1280,
      height: 720,
      title: "Dashboard",
      url: "https://example.com/dashboard",
      source: "playwright",
    });
    apiPostJsonMock.mockResolvedValue({
      status: 200,
      json: { artifactId: "browser-artifact", evidenceRef: "browser-evidence" },
    });

    const result = await desktopPlugin.execute(
      makeCtx(
        "browser.screenshot",
        { selector: "#app", fullPage: false, format: "png" },
        {
          policy: {
            networkPolicy: { allowedDomains: ["*"] },
          } as any,
        },
      ),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.artifactId).toBe("browser-artifact");
    expect(result.outputDigest?.width).toBe(1280);
    expect(result.outputDigest?.height).toBe(720);
    expect(result.outputDigest?.source).toBe("playwright:dom");
    expect(result.outputDigest?.title).toBe("Dashboard");
  });

  it("browser.screenshot falls back to local capture when DOM screenshot is unavailable", async () => {
    browserDomScreenshotMock.mockResolvedValue(null);
    captureScreenMock.mockResolvedValue({ filePath: "browser-fallback.png", width: 640, height: 480 });
    readFileMock.mockResolvedValue(Buffer.from("browser-fallback"));
    cleanupCaptureMock.mockResolvedValue(undefined);
    apiPostJsonMock.mockResolvedValue({
      status: 200,
      json: { artifactId: "browser-fallback-artifact", evidenceRef: "browser-fallback-evidence" },
    });

    const result = await desktopPlugin.execute(
      makeCtx(
        "browser.screenshot",
        { fullPage: true },
        {
          policy: {
            networkPolicy: { allowedDomains: ["*"] },
          } as any,
        },
      ),
    );

    expect(result.status).toBe("succeeded");
    expect(result.outputDigest?.artifactId).toBe("browser-fallback-artifact");
    expect(result.outputDigest?.source).toBe("captureScreen");
    expect(result.outputDigest?.width).toBe(640);
    expect(result.outputDigest?.height).toBe(480);
  });

  it("browser.screenshot rejects url outside network policy", async () => {
    const result = await desktopPlugin.execute(
      makeCtx(
        "browser.screenshot",
        { url: "https://forbidden.example.com/page" },
        {
          policy: {
            networkPolicy: { allowedDomains: ["example.com"] },
          } as any,
        },
      ),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("policy_violation");
    expect(result.outputDigest?.reason).toBe("domain_not_allowed");
    expect(result.outputDigest?.host).toBe("forbidden.example.com");
  });
});
