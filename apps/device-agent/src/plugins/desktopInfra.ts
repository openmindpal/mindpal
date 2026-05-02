/**
 * 桌面基础设施 — 截图、窗口管理、屏幕观察等共享功能。
 * 被 browserPlugin / desktopControlPlugin 等多个子插件复用。
 */
import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apiPostJson } from "@mindpal/device-agent-sdk";
import type { ToolExecutionContext, ToolExecutionResult } from "@mindpal/device-agent-sdk";
import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  type OcrMatch,
} from "./localVision";
import {
  type DesktopCaptureOptions,
  type DesktopWindowInfo,
  type DesktopBackendStatus,
  finiteNumberOrUndefined,
  escapePowerShellSingleQuoted,
  runPowerShell,
  runPowerShellJson,
  runProcess,
  commandExists,
  runOsaScript,
  normalizeBounds,
} from "./pluginUtils";

export { type OcrMatch };

// ── 屏幕观察 ──────────────────────────────────────────────────────

export async function getScreenObservation(): Promise<{ ocrResults: OcrMatch[]; screenTexts: string[] }> {
  const capture = await captureScreen();
  try {
    const ocrResults = await ocrScreen(capture);
    const screenTexts = ocrResults.map((r) => r.text).filter(Boolean);
    return { ocrResults, screenTexts };
  } finally {
    await cleanupCapture(capture);
  }
}

// ── 桌面后端探测 ──────────────────────────────────────────────────

export async function getDesktopBackendStatus(): Promise<DesktopBackendStatus> {
  if (process.platform === "win32") {
    return {
      platform: process.platform,
      windowBackend: "user32+powershell",
      fileDialogBackend: "powershell",
      screenshotBackend: "powershell",
      missingCommands: [],
      accessibilityRequired: false,
    };
  }
  if (process.platform === "darwin") {
    const hasOsa = await commandExists("osascript");
    const hasScreenCapture = await commandExists("screencapture");
    const missingCommands = [
      !hasOsa ? "osascript" : "",
      !hasScreenCapture ? "screencapture" : "",
    ].filter(Boolean);
    return {
      platform: process.platform,
      windowBackend: hasOsa ? "osascript+jxa" : null,
      fileDialogBackend: hasOsa ? "osascript+jxa" : null,
      screenshotBackend: hasScreenCapture ? "screencapture" : null,
      missingCommands,
      accessibilityRequired: true,
    };
  }
  const hasWmctrl = await commandExists("wmctrl");
  const hasXdotool = await commandExists("xdotool");
  const hasScrot = await commandExists("scrot");
  const hasZenity = await commandExists("zenity");
  const hasKdialog = await commandExists("kdialog");
  const missingCommands = [
    !hasScrot ? "scrot" : "",
    !hasWmctrl && !hasXdotool ? "wmctrl|xdotool" : "",
    !hasZenity && !hasKdialog ? "zenity|kdialog" : "",
  ].filter(Boolean);
  return {
    platform: process.platform,
    windowBackend: hasWmctrl ? "wmctrl" : hasXdotool ? "xdotool" : null,
    fileDialogBackend: hasZenity ? "zenity" : hasKdialog ? "kdialog" : null,
    screenshotBackend: hasScrot ? "scrot" : null,
    missingCommands,
    accessibilityRequired: false,
  };
}

// ── 截图基础设施 ──────────────────────────────────────────────────

export const BLANK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/az1JmUAAAAASUVORK5CYII=";

export async function takeDesktopScreenshotBase64(options: DesktopCaptureOptions = {}) {
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const capture = await captureDesktopCapture(options);
      try {
        const buf = await fs.readFile(capture.filePath);
        return {
          contentBase64: buf.toString("base64"),
          width: capture.width,
          height: capture.height,
        };
      } finally {
        await cleanupCapture(capture);
      }
    } catch {
      return null;
    }
  }
  if (process.platform !== "win32") return null;
  const out = path.join(os.tmpdir(), `device_screenshot_${crypto.randomUUID()}.png`);
  const x = finiteNumberOrUndefined(options.x);
  const y = finiteNumberOrUndefined(options.y);
  const width = finiteNumberOrUndefined(options.width);
  const height = finiteNumberOrUndefined(options.height);
  const windowId = String(options.windowId ?? "").trim();
  const useRegion = [x, y, width, height].every((value) => value !== undefined) && Number(width) > 0 && Number(height) > 0;
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    windowId
      ? [
          "Add-Type @'",
          "using System;",
          "using System.Runtime.InteropServices;",
          "public class CaptureWindowRect {",
          "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);",
          "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
          "}",
          "'@",
          `$rect = New-Object CaptureWindowRect+RECT`,
          `[CaptureWindowRect]::GetWindowRect([IntPtr]::new(${windowId}), [ref]$rect) | Out-Null`,
          "$captureX = $rect.Left",
          "$captureY = $rect.Top",
          "$captureWidth = [Math]::Max(1, $rect.Right - $rect.Left)",
          "$captureHeight = [Math]::Max(1, $rect.Bottom - $rect.Top)",
        ].join("; ")
      : useRegion
        ? [
            `$captureX = ${x}`,
            `$captureY = ${y}`,
            `$captureWidth = ${width}`,
            `$captureHeight = ${height}`,
          ].join("; ")
        : [
            "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
            "$captureX = $bounds.X",
            "$captureY = $bounds.Y",
            "$captureWidth = $bounds.Width",
            "$captureHeight = $bounds.Height",
          ].join("; "),
    "$bmp = New-Object System.Drawing.Bitmap $captureWidth, $captureHeight",
    "$graphics = [System.Drawing.Graphics]::FromImage($bmp)",
    "$graphics.CopyFromScreen((New-Object System.Drawing.Point($captureX, $captureY)), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size($captureWidth, $captureHeight)))",
    `$bmp.Save('${escapePowerShellSingleQuoted(out)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$graphics.Dispose()",
    "$bmp.Dispose()",
    "Write-Output \"$($captureWidth)x$($captureHeight)\"",
  ].join("; ");
  const stdout = await runPowerShell(script);
  const buf = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  const match = stdout.match(/(\d+)x(\d+)/);
  return {
    contentBase64: buf.toString("base64"),
    width: Number(match?.[1] ?? 0),
    height: Number(match?.[2] ?? 0),
  };
}

export async function captureDesktopCapture(options: DesktopCaptureOptions = {}) {
  const backendStatus = await getDesktopBackendStatus();
  const hasRegion =
    finiteNumberOrUndefined(options.x) !== undefined &&
    finiteNumberOrUndefined(options.y) !== undefined &&
    finiteNumberOrUndefined(options.width) !== undefined &&
    finiteNumberOrUndefined(options.height) !== undefined;
  const hasWindow = Boolean(String(options.windowId ?? "").trim());
  if (!hasRegion && !hasWindow) {
    return captureScreen();
  }
  if (process.platform === "darwin") {
    if (!backendStatus.screenshotBackend) {
      throw new Error(`missing_backend:${backendStatus.missingCommands.join(",") || "screencapture"}`);
    }
    const out = path.join(os.tmpdir(), `device_capture_${crypto.randomUUID()}.png`);
    const directBounds = hasRegion
      ? {
          x: Number(finiteNumberOrUndefined(options.x) ?? 0),
          y: Number(finiteNumberOrUndefined(options.y) ?? 0),
          width: Math.max(1, Number(finiteNumberOrUndefined(options.width) ?? 1)),
          height: Math.max(1, Number(finiteNumberOrUndefined(options.height) ?? 1)),
        }
      : null;
    const windowBounds = hasWindow ? (await resolveDesktopWindow({ windowId: String(options.windowId ?? "") }))?.bounds ?? null : null;
    const bounds = windowBounds ?? directBounds;
    if (!bounds) return captureScreen();
    const result = await runProcess("screencapture", ["-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, out]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `screencapture_exit_${result.code}`);
    return { filePath: out, width: bounds.width, height: bounds.height };
  }
  if (process.platform === "linux") {
    if (!backendStatus.screenshotBackend) {
      throw new Error(`missing_backend:${backendStatus.missingCommands.join(",") || "scrot"}`);
    }
    const out = path.join(os.tmpdir(), `device_capture_${crypto.randomUUID()}.png`);
    const directBounds = hasRegion
      ? {
          x: Number(finiteNumberOrUndefined(options.x) ?? 0),
          y: Number(finiteNumberOrUndefined(options.y) ?? 0),
          width: Math.max(1, Number(finiteNumberOrUndefined(options.width) ?? 1)),
          height: Math.max(1, Number(finiteNumberOrUndefined(options.height) ?? 1)),
        }
      : null;
    const windowBounds = hasWindow ? (await resolveDesktopWindow({ windowId: String(options.windowId ?? "") }))?.bounds ?? null : null;
    const bounds = windowBounds ?? directBounds;
    if (!bounds) return captureScreen();
    const result = await runProcess("scrot", ["-a", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, out]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `scrot_exit_${result.code}`);
    return { filePath: out, width: bounds.width, height: bounds.height };
  }
  if (process.platform !== "win32") {
    return captureScreen();
  }
  const out = path.join(os.tmpdir(), `device_capture_${crypto.randomUUID()}.png`);
  const x = finiteNumberOrUndefined(options.x);
  const y = finiteNumberOrUndefined(options.y);
  const width = finiteNumberOrUndefined(options.width);
  const height = finiteNumberOrUndefined(options.height);
  const windowId = String(options.windowId ?? "").trim();
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    windowId
      ? [
          "Add-Type @'",
          "using System;",
          "using System.Runtime.InteropServices;",
          "public class DesktopCaptureRect {",
          "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);",
          "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
          "}",
          "'@",
          "$rect = New-Object DesktopCaptureRect+RECT",
          `[DesktopCaptureRect]::GetWindowRect([IntPtr]::new(${windowId}), [ref]$rect) | Out-Null`,
          "$captureX = $rect.Left",
          "$captureY = $rect.Top",
          "$captureWidth = [Math]::Max(1, $rect.Right - $rect.Left)",
          "$captureHeight = [Math]::Max(1, $rect.Bottom - $rect.Top)",
        ].join("; ")
      : [
          `$captureX = ${x}`,
          `$captureY = ${y}`,
          `$captureWidth = ${Math.max(1, Number(width ?? 1))}`,
          `$captureHeight = ${Math.max(1, Number(height ?? 1))}`,
        ].join("; "),
    "$bmp = New-Object System.Drawing.Bitmap $captureWidth, $captureHeight",
    "$graphics = [System.Drawing.Graphics]::FromImage($bmp)",
    "$graphics.CopyFromScreen((New-Object System.Drawing.Point($captureX, $captureY)), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size($captureWidth, $captureHeight)))",
    `$bmp.Save('${escapePowerShellSingleQuoted(out)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$graphics.Dispose()",
    "$bmp.Dispose()",
    "Write-Output \"$($captureWidth)x$($captureHeight)\"",
  ].join("; ");
  const stdout = await runPowerShell(script);
  const match = stdout.match(/(\d+)x(\d+)/);
  return {
    filePath: out,
    width: Number(match?.[1] ?? Math.max(1, Number(width ?? 1))),
    height: Number(match?.[2] ?? Math.max(1, Number(height ?? 1))),
  };
}

export async function captureScreenshotPayload(options: DesktopCaptureOptions = {}): Promise<{ contentBase64: string; width: number; height: number; source: string }> {
  try {
    const capture = await captureDesktopCapture(options);
    try {
      const buf = await fs.readFile(capture.filePath);
      return {
        contentBase64: buf.toString("base64"),
        width: capture.width,
        height: capture.height,
        source: options.windowId || options.width !== undefined ? "captureRegion" : "captureScreen",
      };
    } finally {
      await cleanupCapture(capture);
    }
  } catch {
    const fallback = await takeDesktopScreenshotBase64(options);
    if (fallback) {
      return {
        contentBase64: fallback.contentBase64,
        width: fallback.width,
        height: fallback.height,
        source: "takeDesktopScreenshotBase64",
      };
    }
    return {
      contentBase64: BLANK_PNG_BASE64,
      width: 1,
      height: 1,
      source: "blank_fallback",
    };
  }
}

export async function uploadScreenshotEvidence(
  ctx: ToolExecutionContext,
  payload: { contentBase64: string; width?: number; height?: number; source: string },
): Promise<ToolExecutionResult> {
  const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
    apiBase: ctx.cfg.apiBase,
    path: "/device-agent/evidence/upload",
    token: ctx.cfg.deviceToken,
    body: { deviceExecutionId: ctx.execution.deviceExecutionId, contentBase64: payload.contentBase64, contentType: "image/png", format: "png" },
  });
  if (up.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: up.status } };
  return {
    status: "succeeded",
    outputDigest: {
      ok: true,
      success: true,
      artifactId: up.json?.artifactId ?? null,
      width: payload.width ?? 0,
      height: payload.height ?? 0,
      format: "png",
      source: payload.source,
    },
    evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [],
  };
}

// ── 窗口管理 ──────────────────────────────────────────────────────

export async function resolveDesktopWindow(params: { windowId?: string; title?: string }): Promise<DesktopWindowInfo | null> {
  const windows = await listWindows();
  const wantedId = String(params.windowId ?? "").trim();
  const wantedTitle = String(params.title ?? "").trim().toLowerCase();
  if (wantedId) {
    const byId = windows.find((window) => window.id === wantedId);
    if (byId) return byId;
  }
  if (wantedTitle) {
    const byTitle = windows.find((window) => window.title.toLowerCase().includes(wantedTitle));
    if (byTitle) return byTitle;
  }
  return null;
}

export async function listWindows(): Promise<DesktopWindowInfo[]> {
  if (process.platform === "darwin") {
    const backendStatus = await getDesktopBackendStatus();
    if (!backendStatus.windowBackend) {
      throw new Error(`missing_backend:${backendStatus.missingCommands.join(",") || "osascript"}`);
    }
    const script = `
(() => {
  const se = Application('System Events');
  const items = [];
  const processes = se.applicationProcesses();
  for (let i = 0; i < processes.length; i += 1) {
    try {
      const proc = processes[i];
      if (proc.backgroundOnly()) continue;
      const appName = String(proc.name() || '');
      const windows = proc.windows();
      for (let j = 0; j < windows.length; j += 1) {
        try {
          const win = windows[j];
          const pos = win.position();
          const size = win.size();
          items.push({
            id: String(win.id()),
            title: String(win.name() || ''),
            appName,
            bounds: {
              x: Number(pos[0]),
              y: Number(pos[1]),
              width: Number(size[0]),
              height: Number(size[1]),
            },
          });
        } catch (error) {}
      }
    } catch (error) {}
  }
  return JSON.stringify(items);
})()
    `.trim();
    const raw = await runOsaScript(script, "JavaScript");
    const items = JSON.parse(raw || "[]");
    const arr = Array.isArray(items) ? items : [];
    return arr
      .map((item: any) => ({
        id: String(item?.id ?? ""),
        title: String(item?.title ?? ""),
        appName: String(item?.appName ?? ""),
        bounds: normalizeBounds(item?.bounds),
      }))
      .filter((item) => Boolean(item.id && item.appName));
  }
  if (process.platform === "linux") {
    const backendStatus = await getDesktopBackendStatus();
    if (!backendStatus.windowBackend) {
      throw new Error(`missing_backend:${backendStatus.missingCommands.join(",") || "wmctrl|xdotool"}`);
    }
    if (backendStatus.windowBackend !== "wmctrl") {
      return [];
    }
    const result = await runProcess("wmctrl", ["-lpGx"]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `wmctrl_exit_${result.code}`);
    return result.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\S+)\s+\S+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s*(.*)$/);
        if (!match) return null;
        const [, id, pid, x, y, width, height, wmClass, title] = match;
        return {
          id,
          title: String(title ?? "").trim(),
          appName: String(wmClass ?? pid ?? "").trim(),
          bounds: normalizeBounds({ x: Number(x), y: Number(y), width: Number(width), height: Number(height) }),
        } satisfies DesktopWindowInfo;
      })
      .filter((item): item is DesktopWindowInfo => Boolean(item && item.id));
  }
  if (process.platform !== "win32") return [];
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$items = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object @{Name='id';Expression={[string]$_.MainWindowHandle}}, @{Name='title';Expression={$_.MainWindowTitle}}, @{Name='appName';Expression={$_.ProcessName}}, @{Name='bounds';Expression={$null}}",
    "$items | ConvertTo-Json -Compress",
  ].join("; ");
  const raw = JSON.parse((await runPowerShell(script)).trim() || "[]");
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map((item: any) => ({
    id: String(item.id ?? ""),
    title: String(item.title ?? ""),
    appName: String(item.appName ?? ""),
    bounds: normalizeBounds(item.bounds),
  })).filter((item) => Boolean(item.id && item.title));
}

export function tryLaunch(target: string) {
  const mode = String(process.env.DEVICE_AGENT_LAUNCH_MODE ?? "spawn").toLowerCase();
  if (mode !== "spawn") return false;
  if (process.platform === "win32") {
    childProcess.spawn("cmd.exe", ["/d", "/s", "/c", "start", '""', target], { stdio: "ignore", windowsHide: true });
    return true;
  }
  if (process.platform === "darwin") {
    childProcess.spawn("open", [target], { stdio: "ignore" });
    return true;
  }
  childProcess.spawn("xdg-open", [target], { stdio: "ignore" });
  return true;
}

// ── 文件对话框 ──────────────────────────────────────────────────────

export async function showDesktopFileDialog(input: {
  type: string;
  title?: string;
  filters?: Array<{ name?: string; extensions?: string[] }>;
  defaultPath?: string;
}): Promise<{ selected: boolean; paths: string[] }> {
  if (process.platform === "darwin") {
    const backendStatus = await getDesktopBackendStatus();
    if (!backendStatus.fileDialogBackend) {
      return { selected: false, paths: [] };
    }
    const type = JSON.stringify(String(input.type ?? "").trim().toLowerCase());
    const title = JSON.stringify(String(input.title ?? ""));
    const defaultPath = JSON.stringify(String(input.defaultPath ?? ""));
    const script = `
(() => {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const type = ${type};
  const prompt = ${title};
  const defaultPath = ${defaultPath};
  try {
    let result = null;
    if (type === 'folder') {
      const options = prompt ? { withPrompt: prompt } : {};
      if (defaultPath) options.defaultLocation = Path(defaultPath);
      result = app.chooseFolder(options);
    } else if (type === 'save') {
      const options = prompt ? { withPrompt: prompt } : {};
      if (defaultPath) options.defaultLocation = Path(defaultPath);
      result = app.chooseFileName(options);
    } else {
      const options = prompt ? { withPrompt: prompt } : {};
      options.multipleSelectionsAllowed = false;
      if (defaultPath) options.defaultLocation = Path(defaultPath);
      result = app.chooseFile(options);
    }
    return JSON.stringify({ selected: true, paths: [result.toString()] });
  } catch (error) {
    return JSON.stringify({ selected: false, paths: [] });
  }
})()
    `.trim();
    const result = JSON.parse(await runOsaScript(script, "JavaScript") || "{}");
    return {
      selected: Boolean((result as any)?.selected),
      paths: Array.isArray((result as any)?.paths) ? (result as any).paths.map(String) : [],
    };
  }
  if (process.platform === "linux") {
    const backendStatus = await getDesktopBackendStatus();
    if (!backendStatus.fileDialogBackend) {
      return { selected: false, paths: [] };
    }
    const kind = String(input.type ?? "").trim().toLowerCase();
    const title = String(input.title ?? "").trim();
    const defaultPath = String(input.defaultPath ?? "").trim();
    const filters = Array.isArray(input.filters) ? input.filters : [];
    if (await commandExists("zenity")) {
      const args = ["--file-selection"];
      if (title) args.push(`--title=${title}`);
      if (kind === "save") args.push("--save", "--confirm-overwrite");
      if (kind === "folder") args.push("--directory");
      if (defaultPath) args.push(`--filename=${defaultPath}`);
      for (const filter of filters) {
        const exts = Array.isArray(filter?.extensions) ? filter.extensions : [];
        if (!exts.length) continue;
        const name = String(filter?.name ?? "Files").trim() || "Files";
        args.push(`--file-filter=${name} | ${exts.map((ext) => `*.${String(ext).replace(/^\./, "")}`).join(" ")}`);
      }
      const result = await runProcess("zenity", args);
      if (result.code !== 0) return { selected: false, paths: [] };
      const selected = result.stdout.trim();
      return { selected: Boolean(selected), paths: selected ? [selected] : [] };
    }
    if (await commandExists("kdialog")) {
      const args = kind === "save"
        ? ["--getsavefilename", defaultPath || ""]
        : kind === "folder"
          ? ["--getexistingdirectory", defaultPath || ""]
          : ["--getopenfilename", defaultPath || ""];
      if (title) args.push("--title", title);
      const result = await runProcess("kdialog", args);
      if (result.code !== 0) return { selected: false, paths: [] };
      const selected = result.stdout.trim();
      return { selected: Boolean(selected), paths: selected ? [selected] : [] };
    }
    return { selected: false, paths: [] };
  }
  const title = escapePowerShellSingleQuoted(String(input.title ?? ""));
  const defaultPath = escapePowerShellSingleQuoted(String(input.defaultPath ?? ""));
  const filters = Array.isArray(input.filters) ? input.filters : [];
  const filterText = filters
    .map((item) => {
      const name = String(item?.name ?? "Files").trim() || "Files";
      const exts = Array.isArray(item?.extensions) ? item.extensions : [];
      const pattern = exts.length ? exts.map((ext) => `*.${String(ext).replace(/^\./, "")}`).join(";") : "*.*";
      return `${name}|${pattern}`;
    })
    .join("|");
  const escapedFilterText = escapePowerShellSingleQuoted(filterText);
  const kind = String(input.type ?? "").trim().toLowerCase();
  const script = kind === "folder"
    ? [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
        title ? `$dlg.Description = '${title}'` : "",
        defaultPath ? `$dlg.SelectedPath = '${defaultPath}'` : "",
        "$result = $dlg.ShowDialog()",
        "$paths = @()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) { $paths = @($dlg.SelectedPath) }",
        "@{ selected = ($paths.Count -gt 0); paths = $paths } | ConvertTo-Json -Compress",
      ].filter(Boolean).join("; ")
    : [
        "Add-Type -AssemblyName System.Windows.Forms",
        kind === "save"
          ? "$dlg = New-Object System.Windows.Forms.SaveFileDialog"
          : "$dlg = New-Object System.Windows.Forms.OpenFileDialog",
        title ? `$dlg.Title = '${title}'` : "",
        defaultPath ? `$dlg.InitialDirectory = '${defaultPath}'` : "",
        escapedFilterText ? `$dlg.Filter = '${escapedFilterText}'` : "",
        "$result = $dlg.ShowDialog()",
        "$paths = @()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
        kind === "save" ? "  if ($dlg.FileName) { $paths = @($dlg.FileName) }" : "  if ($dlg.FileNames) { $paths = @($dlg.FileNames) }",
        "}",
        "@{ selected = ($paths.Count -gt 0); paths = $paths } | ConvertTo-Json -Compress",
      ].filter(Boolean).join("; ");
  return await runPowerShellJson<{ selected?: boolean; paths?: string[] }>(script, { sta: true }).then((result) => ({
    selected: Boolean(result?.selected),
    paths: Array.isArray(result?.paths) ? result.paths.map(String) : [],
  }));
}
