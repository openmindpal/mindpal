/**
 * 桌面控制子插件 — 处理 device.desktop.* 工具
 * 包含：launch / screenshot / ocr / window / mouse / keyboard / drag / file.dialog
 */
import type { CapabilityDescriptor } from "../kernel";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";
import {
  clickMouse,
  typeText as localTypeText,
  pressKey,
  pressCombo,
  moveMouse,
  ocrScreen,
  cleanupCapture,
} from "./localVision";
import {
  getOrCreateSession,
  touchSession,
  getActiveSessionByType,
} from "../sessionManager";
import { finiteNumberOrUndefined, sleep, runPowerShell, runProcess, commandExists, runOsaScript } from "./pluginUtils";

// ── 桌面会话便捷函数 ────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000;

function getDesktopSession() {
  return getOrCreateSession({ sessionType: "desktop", metadata: { platform: process.platform }, ttlMs: SESSION_TTL_MS });
}

function touchDesktopSession() {
  const session = getActiveSessionByType("desktop");
  if (session) touchSession(session.sessionId);
}
import {
  getDesktopBackendStatus,
  resolveDesktopWindow,
  listWindows,
  tryLaunch,
  showDesktopFileDialog,
  captureDesktopCapture,
  captureScreenshotPayload,
  uploadScreenshotEvidence,
} from "./desktopInfra";

// ── 窗口列表 ──────────────────────────────────────────────────────

async function execDesktopWindowList(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const filter = String(ctx.input.filter ?? "").trim().toLowerCase();
  try {
    const backendStatus = await getDesktopBackendStatus();
    const windows = await listWindows();
    const filtered = filter
      ? windows.filter((item) => item.title.toLowerCase().includes(filter) || item.appName.toLowerCase().includes(filter))
      : windows;
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, windows: filtered, count: filtered.length, platform: backendStatus.platform, windowBackend: backendStatus.windowBackend, missingCommands: backendStatus.missingCommands } };
  } catch (err: any) {
    const backendStatus = await getDesktopBackendStatus().catch(() => null);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "window_list_failed", error: String(err?.message ?? err).slice(0, 200), platform: backendStatus?.platform ?? process.platform, windowBackend: backendStatus?.windowBackend ?? null, missingCommands: backendStatus?.missingCommands ?? [], accessibilityRequired: backendStatus?.accessibilityRequired ?? false } };
  }
}

// ── 启动应用 ──────────────────────────────────────────────────────

async function execDesktopLaunch(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const app = String(ctx.input.app ?? ctx.input.appPath ?? "");
  if (!app) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "appPath" } };
  const ui = ctx.policy?.uiPolicy ?? null;
  const allowedApps = Array.isArray(ui?.allowedApps) ? ui.allowedApps.map((x: any) => String(x)).filter(Boolean) : [];
  if (!allowedApps.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "ui_denied" } };
  const appAllowed = allowedApps.includes("*") || allowedApps.includes(app);
  if (!appAllowed) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "app_not_allowed", app } };
  const launched = tryLaunch(app);
  touchDesktopSession();
  return { status: "succeeded", outputDigest: { ok: true, success: true, app, launched, pid: null, windowId: null, launchMode: String(process.env.DEVICE_AGENT_LAUNCH_MODE ?? "spawn").toLowerCase() } };
}

// ── 截图 / OCR ────────────────────────────────────────────────────

async function execDesktopScreenshot(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const payload = await captureScreenshotPayload({
    x: finiteNumberOrUndefined(ctx.input.x),
    y: finiteNumberOrUndefined(ctx.input.y),
    width: finiteNumberOrUndefined(ctx.input.width),
    height: finiteNumberOrUndefined(ctx.input.height),
    windowId: typeof ctx.input.windowId === "string" ? String(ctx.input.windowId) : undefined,
  });
  touchDesktopSession();
  return uploadScreenshotEvidence(ctx, payload);
}

async function execDesktopOcr(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  try {
    const capture = await captureDesktopCapture({
      x: finiteNumberOrUndefined(ctx.input.x),
      y: finiteNumberOrUndefined(ctx.input.y),
      width: finiteNumberOrUndefined(ctx.input.width),
      height: finiteNumberOrUndefined(ctx.input.height),
      windowId: typeof ctx.input.windowId === "string" ? String(ctx.input.windowId) : undefined,
    });
    try {
      const ocrResults = await ocrScreen(capture);
      touchDesktopSession();
      return {
        status: "succeeded",
        outputDigest: {
          success: true,
          text: ocrResults.map((item) => item.text).filter(Boolean).join("\n"),
          blocks: ocrResults.map((item) => ({ text: item.text, bounds: item.bbox, confidence: item.confidence })),
          width: capture.width, height: capture.height,
        },
      };
    } finally {
      await cleanupCapture(capture);
    }
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "screen_ocr_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

// ── 鼠标操作 ──────────────────────────────────────────────────────

async function execMouseClick(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const x = Number(ctx.input.x);
  const y = Number(ctx.input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "x,y" } };
  const button = String(ctx.input.button ?? "left") as "left" | "right";
  const clickCount = Math.max(1, Number(ctx.input.clickCount ?? 1) || 1);
  try {
    for (let i = 0; i < clickCount; i++) {
      await clickMouse(x, y, button);
      if (i < clickCount - 1) await new Promise(r => setTimeout(r, 80));
    }
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, x, y, button, clickCount } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "mouse_click_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

async function execMouseMove(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const x = Number(ctx.input.x);
  const y = Number(ctx.input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "x,y" } };
  try {
    await moveMouse(x, y);
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, x, y } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "mouse_move_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

async function execMouseDrag(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const startX = Number(ctx.input.startX);
  const startY = Number(ctx.input.startY);
  const endX = Number(ctx.input.endX);
  const endY = Number(ctx.input.endY);
  if ([startX, startY, endX, endY].some(v => !Number.isFinite(v))) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "startX,startY,endX,endY" } };
  try {
    await moveMouse(startX, startY);
    if (process.platform === "win32") {
      const { spawnSync } = await import("node:child_process");
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        `Add-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class DragSim { [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,int d,int i); public static void Down(){ mouse_event(0x0002,0,0,0,0); } public static void Up(){ mouse_event(0x0004,0,0,0,0); } }\n'@; [DragSim]::Down()`
      ], { stdio: "ignore" });
      await moveMouse(endX, endY);
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        `Add-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class DragSim2 { [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,int d,int i); public static void Up(){ mouse_event(0x0004,0,0,0,0); } }\n'@; [DragSim2]::Up()`
      ], { stdio: "ignore" });
    } else {
      await clickMouse(startX, startY);
      await moveMouse(endX, endY);
    }
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, startX, startY, endX, endY } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "mouse_drag_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

// ── 键盘操作 ──────────────────────────────────────────────────────

async function execKeyboardType(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const text = String(ctx.input.text ?? "");
  if (!text) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "text" } };
  try {
    await localTypeText(text);
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, charCount: text.length } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "keyboard_type_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

async function execKeyboardHotkey(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const keys = Array.isArray(ctx.input.keys) ? ctx.input.keys.map(String) : String(ctx.input.keys ?? "").split("+").map(s => s.trim()).filter(Boolean);
  if (!keys.length) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "keys" } };
  try {
    await pressCombo(keys);
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, keys } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "hotkey_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

// ── 窗口管理 ──────────────────────────────────────────────────────

async function execWindowFocus(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const windowId = String(ctx.input.windowId ?? "");
  const title = String(ctx.input.title ?? "");
  if (!windowId && !title) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "windowId or title" } };
  try {
    const backendStatus = await getDesktopBackendStatus();
    if (!backendStatus.windowBackend) {
      return { status: "failed", errorCategory: "device_not_ready", outputDigest: { reason: "window_backend_unavailable", platform: backendStatus.platform, missingCommands: backendStatus.missingCommands, accessibilityRequired: backendStatus.accessibilityRequired } };
    }
    const match = await resolveDesktopWindow({ windowId, title });
    if (!match) return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "window_not_found", windowId, title } };
    if (process.platform === "win32") {
      const script = [
        `Add-Type @'`,
        `using System; using System.Runtime.InteropServices;`,
        `public class WinFocus {`,
        `  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);`,
        `  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);`,
        `}`,
        `'@`,
        `$h = [IntPtr]::new(${match.id})`,
        `[WinFocus]::ShowWindow($h, 9)`,
        `[WinFocus]::SetForegroundWindow($h)`,
      ].join("\n");
      const { spawnSync } = await import("node:child_process");
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      const script = `
(() => {
  const se = Application('System Events');
  const proc = se.applicationProcesses.byName(${JSON.stringify(match.appName)});
  proc.frontmost = true;
  const windows = proc.windows();
  for (let i = 0; i < windows.length; i += 1) {
    try {
      const win = windows[i];
      if (String(win.id()) === ${JSON.stringify(match.id)}) {
        try { win.actions.byName('AXRaise').perform(); } catch (error) {}
        try { proc.frontmost = true; } catch (error) {}
        break;
      }
    } catch (error) {}
  }
  return 'ok';
})()
      `.trim();
      await runOsaScript(script, "JavaScript");
    } else if (process.platform === "linux") {
      if (await commandExists("wmctrl")) {
        const result = await runProcess("wmctrl", ["-ia", match.id]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `wmctrl_exit_${result.code}`);
      } else {
        const result = await runProcess("xdotool", ["windowactivate", "--sync", match.id]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `xdotool_exit_${result.code}`);
      }
    }
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, windowId: match.id, title: match.title, appName: match.appName, windowBackend: backendStatus.windowBackend } };
  } catch (err: any) {
    const backendStatus = await getDesktopBackendStatus().catch(() => null);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "window_focus_failed", error: String(err?.message ?? err).slice(0, 200), platform: backendStatus?.platform ?? process.platform, windowBackend: backendStatus?.windowBackend ?? null, missingCommands: backendStatus?.missingCommands ?? [], accessibilityRequired: backendStatus?.accessibilityRequired ?? false } };
  }
}

async function execWindowResize(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  const windowId = String(ctx.input.windowId ?? "");
  if (!windowId) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "windowId" } };
  const x = ctx.input.x !== undefined ? Number(ctx.input.x) : undefined;
  const y = ctx.input.y !== undefined ? Number(ctx.input.y) : undefined;
  const width = ctx.input.width !== undefined ? Number(ctx.input.width) : undefined;
  const height = ctx.input.height !== undefined ? Number(ctx.input.height) : undefined;
  try {
    const backendStatus = await getDesktopBackendStatus();
    if (!backendStatus.windowBackend) {
      return { status: "failed", errorCategory: "device_not_ready", outputDigest: { reason: "window_backend_unavailable", platform: backendStatus.platform, missingCommands: backendStatus.missingCommands, accessibilityRequired: backendStatus.accessibilityRequired } };
    }
    const match = await resolveDesktopWindow({ windowId });
    if (!match) return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "window_not_found", windowId } };
    const currentBounds = match.bounds ?? { x: 0, y: 0, width: 1280, height: 720 };
    const nextX = x !== undefined ? x : currentBounds.x;
    const nextY = y !== undefined ? y : currentBounds.y;
    const nextWidth = width !== undefined ? width : currentBounds.width;
    const nextHeight = height !== undefined ? height : currentBounds.height;
    if (process.platform === "win32") {
      const script = [
        `Add-Type @'`, `using System; using System.Runtime.InteropServices;`,
        `public class WinResize {`,
        `  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);`,
        `  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);`,
        `  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }`,
        `}`, `'@`,
        `$h = [IntPtr]::new(${match.id})`,
        `$r = New-Object WinResize+RECT`,
        `[WinResize]::GetWindowRect($h, [ref]$r)`,
        `$nx = ${nextX}`, `$ny = ${nextY}`, `$nw = ${nextWidth}`, `$nh = ${nextHeight}`,
        `[WinResize]::MoveWindow($h, $nx, $ny, $nw, $nh, $true)`,
      ].join("\n");
      const { spawnSync } = await import("node:child_process");
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      const script = `
(() => {
  const se = Application('System Events');
  const proc = se.applicationProcesses.byName(${JSON.stringify(match.appName)});
  const windows = proc.windows();
  for (let i = 0; i < windows.length; i += 1) {
    try {
      const win = windows[i];
      if (String(win.id()) === ${JSON.stringify(match.id)}) {
        win.position = [${nextX}, ${nextY}];
        win.size = [${nextWidth}, ${nextHeight}];
        return 'ok';
      }
    } catch (error) {}
  }
  throw new Error('window_not_found');
})()
      `.trim();
      await runOsaScript(script, "JavaScript");
    } else if (process.platform === "linux") {
      if (await commandExists("wmctrl")) {
        const result = await runProcess("wmctrl", ["-ir", match.id, "-e", `0,${nextX},${nextY},${nextWidth},${nextHeight}`]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `wmctrl_exit_${result.code}`);
      } else {
        const moveResult = await runProcess("xdotool", ["windowmove", match.id, String(nextX), String(nextY)]);
        if (moveResult.code !== 0) throw new Error(moveResult.stderr.trim() || `xdotool_move_exit_${moveResult.code}`);
        const sizeResult = await runProcess("xdotool", ["windowsize", match.id, String(nextWidth), String(nextHeight)]);
        if (sizeResult.code !== 0) throw new Error(sizeResult.stderr.trim() || `xdotool_size_exit_${sizeResult.code}`);
      }
    }
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, windowId: match.id, x: nextX, y: nextY, width: nextWidth, height: nextHeight, windowBackend: backendStatus.windowBackend } };
  } catch (err: any) {
    const backendStatus = await getDesktopBackendStatus().catch(() => null);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "window_resize_failed", error: String(err?.message ?? err).slice(0, 200), platform: backendStatus?.platform ?? process.platform, windowBackend: backendStatus?.windowBackend ?? null, missingCommands: backendStatus?.missingCommands ?? [], accessibilityRequired: backendStatus?.accessibilityRequired ?? false } };
  }
}

// ── 文件对话框 ────────────────────────────────────────────────────

async function execDesktopFileDialog(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getDesktopSession();
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const type = String(ctx.input.type ?? "").trim().toLowerCase();
  if (!["open", "save", "folder"].includes(type)) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "type" } };
  try {
    const backendStatus = await getDesktopBackendStatus();
    if (!backendStatus.fileDialogBackend) {
      return { status: "failed", errorCategory: "device_not_ready", outputDigest: { reason: "file_dialog_backend_unavailable", platform: backendStatus.platform, missingCommands: backendStatus.missingCommands, accessibilityRequired: backendStatus.accessibilityRequired } };
    }
    const result = await showDesktopFileDialog({
      type,
      title: typeof ctx.input.title === "string" ? String(ctx.input.title) : undefined,
      filters: Array.isArray(ctx.input.filters) ? ctx.input.filters as Array<{ name?: string; extensions?: string[] }> : undefined,
      defaultPath: typeof ctx.input.defaultPath === "string" ? String(ctx.input.defaultPath) : undefined,
    });
    touchDesktopSession();
    return { status: "succeeded", outputDigest: { success: true, selected: result.selected, paths: result.paths, fileDialogBackend: backendStatus.fileDialogBackend } };
  } catch (err: any) {
    const backendStatus = await getDesktopBackendStatus().catch(() => null);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "file_dialog_failed", error: String(err?.message ?? err).slice(0, 200), platform: backendStatus?.platform ?? process.platform, fileDialogBackend: backendStatus?.fileDialogBackend ?? null, missingCommands: backendStatus?.missingCommands ?? [], accessibilityRequired: backendStatus?.accessibilityRequired ?? false } };
  }
}

// ── 路由表 ────────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.desktop.launch": execDesktopLaunch,
  "device.desktop.screenshot": execDesktopScreenshot,
  "device.desktop.screen.ocr": execDesktopOcr,
  "device.desktop.window.list": execDesktopWindowList,
  "device.desktop.window.focus": execWindowFocus,
  "device.desktop.window.resize": execWindowResize,
  "device.desktop.mouse.click": execMouseClick,
  "device.desktop.mouse.move": execMouseMove,
  "device.desktop.mouse.drag": execMouseDrag,
  "device.desktop.keyboard.type": execKeyboardType,
  "device.desktop.keyboard.hotkey": execKeyboardHotkey,
  "device.desktop.file.dialog": execDesktopFileDialog,
};

// ── 能力声明 ──────────────────────────────────────────────────────

const successOutputSchema = { type: "object", properties: { success: { type: "boolean" } }, additionalProperties: true };
const stringArraySchema = { type: "array", items: { type: "string" } };
const windowSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    appName: { type: "string" },
  },
  additionalProperties: true,
};

const DESKTOP_CONTROL_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.desktop.launch", riskLevel: "high", inputSchema: { type: "object", properties: { appPath: { type: "string" }, args: stringArraySchema }, required: ["appPath"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 192, cpuPercent: 35 }, concurrencyLimit: 1, version: "1.0.0", tags: ["desktop"], description: "启动允许的本地应用" },
  { toolRef: "device.desktop.screenshot", riskLevel: "medium", inputSchema: { type: "object", properties: { monitor: { type: "number" } }, additionalProperties: true }, outputSchema: { type: "object", properties: { artifactId: { type: "string" }, evidenceRefs: stringArraySchema }, additionalProperties: true }, resourceRequirements: { memoryMb: 256, cpuPercent: 35 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "evidence"], description: "采集桌面截图" },
  { toolRef: "device.desktop.screen.ocr", riskLevel: "medium", inputSchema: { type: "object", properties: { region: { type: "object" } }, additionalProperties: true }, outputSchema: { type: "object", properties: { texts: stringArraySchema }, additionalProperties: true }, resourceRequirements: { memoryMb: 256, cpuPercent: 60 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "vision"], description: "执行桌面 OCR 识别" },
  { toolRef: "device.desktop.window.list", riskLevel: "low", inputSchema: { type: "object", properties: { filter: { type: "string" } }, additionalProperties: true }, outputSchema: { type: "object", properties: { windows: { type: "array", items: windowSchema }, count: { type: "number" } }, additionalProperties: true }, resourceRequirements: { memoryMb: 96, cpuPercent: 15 }, concurrencyLimit: 4, version: "1.0.0", tags: ["desktop", "window"], description: "列出桌面窗口" },
  { toolRef: "device.desktop.window.focus", riskLevel: "medium", inputSchema: { type: "object", properties: { windowId: { type: "string" }, title: { type: "string" } }, additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 96, cpuPercent: 20 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "window"], description: "聚焦桌面窗口" },
  { toolRef: "device.desktop.window.resize", riskLevel: "medium", inputSchema: { type: "object", properties: { windowId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["windowId"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 96, cpuPercent: 20 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "window"], description: "调整桌面窗口大小与位置" },
  { toolRef: "device.desktop.mouse.click", riskLevel: "high", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, clickCount: { type: "number" } }, required: ["x", "y"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 64, cpuPercent: 20 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "mouse"], description: "执行桌面鼠标点击" },
  { toolRef: "device.desktop.mouse.move", riskLevel: "medium", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 64, cpuPercent: 15 }, concurrencyLimit: 4, version: "1.0.0", tags: ["desktop", "mouse"], description: "移动桌面鼠标" },
  { toolRef: "device.desktop.mouse.drag", riskLevel: "high", inputSchema: { type: "object", properties: { startX: { type: "number" }, startY: { type: "number" }, endX: { type: "number" }, endY: { type: "number" } }, required: ["startX", "startY", "endX", "endY"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 96, cpuPercent: 25 }, concurrencyLimit: 1, version: "1.0.0", tags: ["desktop", "mouse"], description: "执行桌面鼠标拖拽" },
  { toolRef: "device.desktop.keyboard.type", riskLevel: "high", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 64, cpuPercent: 15 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "keyboard"], description: "执行桌面键盘输入" },
  { toolRef: "device.desktop.keyboard.hotkey", riskLevel: "high", inputSchema: { type: "object", properties: { keys: { anyOf: [stringArraySchema, { type: "string" }] } }, required: ["keys"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 64, cpuPercent: 15 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "keyboard"], description: "执行桌面快捷键" },
  { toolRef: "device.desktop.file.dialog", riskLevel: "medium", inputSchema: { type: "object", properties: { type: { type: "string" }, title: { type: "string" }, defaultPath: { type: "string" } }, required: ["type"], additionalProperties: true }, outputSchema: { type: "object", properties: { success: { type: "boolean" }, selected: { type: "string" }, paths: stringArraySchema }, additionalProperties: true }, resourceRequirements: { memoryMb: 96, cpuPercent: 15 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "file"], description: "打开桌面文件对话框" },
];

// ── 导出插件实例 ──────────────────────────────────────────────────

const desktopControlPlugin: DeviceToolPlugin = {
  name: "desktop-control",
  version: "1.0.0",
  toolPrefixes: ["device.desktop"],
  capabilities: DESKTOP_CONTROL_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 512, maxCpuPercent: 80, maxConcurrency: 2, maxExecutionTimeMs: 120000 },
  toolNames: Object.keys(TOOL_HANDLERS),
  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "desktop-control" } };
    return handler(ctx);
  },
};

export default desktopControlPlugin;
