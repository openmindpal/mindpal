/**
 * 设备能力探测器
 *
 * 在插件 init 阶段探测实际硬件/软件能力（摄像头、GPU、浏览器、屏幕、网络等），
 * 返回 DeviceCapabilityReport，供 pluginLifecycle 过滤不可用能力。
 *
 * @layer plugin
 */
import os from "node:os";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";

// ── 能力报告类型 ──────────────────────────────────────────

export interface DeviceCapabilityReport {
  /** 探测时间戳 */
  probedAt: string;
  /** 操作系统平台 */
  platform: NodeJS.Platform;
  /** CPU 架构 */
  arch: string;
  /** 总物理内存（MB） */
  totalMemoryMb: number;
  /** 可用内存（MB） */
  freeMemoryMb: number;
  /** CPU 核心数 */
  cpuCores: number;

  /** 硬件能力标记 */
  hardware: {
    /** 是否有可用摄像头 */
    hasCamera: boolean;
    /** 是否有可用 GPU */
    hasGpu: boolean;
    /** GPU 描述（可选） */
    gpuDescription?: string;
    /** 屏幕信息（headless 环境可能为 null） */
    screen: { width: number; height: number } | null;
    /** 是否有麦克风 */
    hasMicrophone: boolean;
    /** 是否有触摸屏 */
    hasTouchscreen: boolean;
  };

  /** 软件能力标记 */
  software: {
    /** 是否有可用浏览器（Chrome/Chromium/Edge） */
    hasBrowser: boolean;
    /** 检测到的浏览器路径（可选） */
    browserPath?: string;
    /** 是否有 GUI 桌面环境（非 headless） */
    hasDesktopGui: boolean;
    /** 是否有剪贴板访问能力 */
    hasClipboard: boolean;
    /** Node.js 版本 */
    nodeVersion: string;
  };

  /** 网络能力 */
  network: {
    /** 是否有网络连接 */
    hasNetwork: boolean;
    /** 网络接口数量 */
    interfaceCount: number;
  };

  /** 探测过程中的警告（非致命） */
  warnings: string[];
}

// ── 能力 → 工具前缀关联（用于过滤） ──────────────────────

/**
 * 能力标记到工具前缀的关联映射。
 * 如果某能力标记为 false，对应前缀的工具将被标记为 unavailable。
 */
export const CAPABILITY_TOOL_PREFIX_MAP: Record<string, (report: DeviceCapabilityReport) => boolean> = {
  "device.browser.": (r) => r.software.hasBrowser,
  "device.desktop.": (r) => r.software.hasDesktopGui,
  "device.clipboard.": (r) => r.software.hasClipboard,
  "device.vision.": (r) => r.hardware.hasCamera,
  "device.camera.": (r) => r.hardware.hasCamera,
  "device.gpu.": (r) => r.hardware.hasGpu,
  "device.audio.": (r) => r.hardware.hasMicrophone,
  "device.screen.": (r) => r.hardware.screen !== null,
};

/**
 * 注册自定义能力-工具关联规则
 */
export function registerCapabilityToolRule(
  toolPrefix: string,
  predicate: (report: DeviceCapabilityReport) => boolean,
): void {
  CAPABILITY_TOOL_PREFIX_MAP[toolPrefix] = predicate;
}

/**
 * 检查某个工具引用在当前设备上是否可用
 */
export function isToolAvailableOnDevice(toolRef: string, report: DeviceCapabilityReport): boolean {
  for (const [prefix, predicate] of Object.entries(CAPABILITY_TOOL_PREFIX_MAP)) {
    if (toolRef.startsWith(prefix)) {
      return predicate(report);
    }
  }
  // 没有匹配的规则 → 默认可用
  return true;
}

// ── 探测逻辑 ──────────────────────────────────────────

let _cachedReport: DeviceCapabilityReport | null = null;

/**
 * 执行完整设备能力探测（结果会被缓存，仅首次调用会实际探测）
 */
export async function probeDeviceCapabilities(forceRefresh = false): Promise<DeviceCapabilityReport> {
  if (_cachedReport && !forceRefresh) return _cachedReport;

  const warnings: string[] = [];
  const platform = os.platform();

  // 基础硬件信息
  const totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemoryMb = Math.round(os.freemem() / 1024 / 1024);
  const cpuCores = os.cpus().length;

  // GPU 探测
  const gpuInfo = probeGpu(platform, warnings);

  // 摄像头探测
  const hasCamera = await probeCamera(platform, warnings);

  // 浏览器探测
  const browserInfo = probeBrowser(platform, warnings);

  // 桌面 GUI 探测
  const hasDesktopGui = probeDesktopGui(platform, warnings);

  // 屏幕探测
  const screen = probeScreen(platform, warnings);

  // 网络探测
  const networkInfo = probeNetwork();

  // 剪贴板探测（有桌面环境就有剪贴板）
  const hasClipboard = hasDesktopGui;

  // 麦克风探测（简化：桌面/移动设备默认有，IoT 设备默认没有）
  const hasMicrophone = platform === "win32" || platform === "darwin";

  // 触摸屏探测（简化）
  const hasTouchscreen = false; // 需要更底层的探测，暂默认 false

  const report: DeviceCapabilityReport = {
    probedAt: new Date().toISOString(),
    platform,
    arch: os.arch(),
    totalMemoryMb,
    freeMemoryMb,
    cpuCores,
    hardware: {
      hasCamera,
      hasGpu: gpuInfo.hasGpu,
      gpuDescription: gpuInfo.description,
      screen,
      hasMicrophone,
      hasTouchscreen,
    },
    software: {
      hasBrowser: browserInfo.hasBrowser,
      browserPath: browserInfo.browserPath,
      hasDesktopGui,
      hasClipboard,
      nodeVersion: process.version,
    },
    network: networkInfo,
    warnings,
  };

  _cachedReport = report;
  return report;
}

/**
 * 获取缓存的能力报告（如果已探测过）
 */
export function getCachedCapabilityReport(): DeviceCapabilityReport | null {
  return _cachedReport;
}

/**
 * 清除缓存（下次调用 probeDeviceCapabilities 会重新探测）
 */
export function clearCapabilityCache(): void {
  _cachedReport = null;
}

// ── 内部探测函数 ──────────────────────────────────────────

function probeGpu(platform: NodeJS.Platform, warnings: string[]): { hasGpu: boolean; description?: string } {
  try {
    if (platform === "win32") {
      const output = execSync("wmic path win32_VideoController get Name /format:list", {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const match = output.match(/Name=(.+)/);
      if (match) {
        const name = match[1].trim();
        // 排除基本显示适配器（虚拟机/无独立 GPU）
        const isBasic = /basic|microsoft|standard vga/i.test(name);
        return { hasGpu: !isBasic, description: name };
      }
    } else if (platform === "darwin") {
      const output = execSync("system_profiler SPDisplaysDataType 2>/dev/null | head -20", {
        encoding: "utf8",
        timeout: 5000,
      });
      const match = output.match(/Chipset Model:\s*(.+)/);
      if (match) return { hasGpu: true, description: match[1].trim() };
    } else {
      // Linux
      try {
        const output = execSync("lspci 2>/dev/null | grep -i vga", { encoding: "utf8", timeout: 5000 });
        if (output.trim()) return { hasGpu: true, description: output.trim().split("\n")[0] };
      } catch {
        // lspci 不可用，尝试读取 /proc
        try {
          const dri = execSync("ls /dev/dri/ 2>/dev/null", { encoding: "utf8", timeout: 3000 });
          if (dri.includes("card")) return { hasGpu: true };
        } catch { /* ignore */ }
      }
    }
  } catch (e: any) {
    warnings.push(`gpu_probe_failed: ${e?.message ?? "unknown"}`);
  }
  return { hasGpu: false };
}

async function probeCamera(platform: NodeJS.Platform, warnings: string[]): Promise<boolean> {
  try {
    if (platform === "win32") {
      const output = execSync("wmic path Win32_PnPEntity where \"Caption like '%camera%' or Caption like '%webcam%' or Caption like '%video%'\" get Caption /format:list", {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      return /Caption=.+/i.test(output);
    } else if (platform === "darwin") {
      const output = execSync("system_profiler SPCameraDataType 2>/dev/null | head -10", {
        encoding: "utf8",
        timeout: 5000,
      });
      return output.includes("Model");
    } else {
      // Linux：检查 /dev/video*
      try {
        const files = await fs.readdir("/dev");
        return files.some((f) => f.startsWith("video"));
      } catch {
        return false;
      }
    }
  } catch (e: any) {
    warnings.push(`camera_probe_failed: ${e?.message ?? "unknown"}`);
    return false;
  }
}

function probeBrowser(platform: NodeJS.Platform, warnings: string[]): { hasBrowser: boolean; browserPath?: string } {
  const candidates: string[] = [];

  if (platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    // Linux: 尝试 which
    for (const cmd of ["google-chrome", "chromium-browser", "chromium", "microsoft-edge"]) {
      try {
        const result = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf8", timeout: 3000 }).trim();
        if (result) return { hasBrowser: true, browserPath: result };
      } catch { /* not found */ }
    }
  }

  for (const p of candidates) {
    try {
      // 同步检查文件是否存在
      const stat = require("node:fs").statSync(p);
      if (stat.isFile()) return { hasBrowser: true, browserPath: p };
    } catch { /* not found */ }
  }

  warnings.push("browser_not_found: no Chrome/Edge/Chromium detected");
  return { hasBrowser: false };
}

function probeDesktopGui(platform: NodeJS.Platform, warnings: string[]): boolean {
  if (platform === "win32" || platform === "darwin") return true;
  // Linux：检查 DISPLAY 或 WAYLAND_DISPLAY 环境变量
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  warnings.push("no_desktop_gui: headless environment detected");
  return false;
}

function probeScreen(platform: NodeJS.Platform, warnings: string[]): { width: number; height: number } | null {
  try {
    if (platform === "win32") {
      const output = execSync("wmic path Win32_VideoController get CurrentHorizontalResolution,CurrentVerticalResolution /format:list", {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const w = output.match(/CurrentHorizontalResolution=(\d+)/);
      const h = output.match(/CurrentVerticalResolution=(\d+)/);
      if (w && h) return { width: parseInt(w[1], 10), height: parseInt(h[1], 10) };
    } else if (platform === "darwin") {
      const output = execSync("system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution", {
        encoding: "utf8",
        timeout: 5000,
      });
      const match = output.match(/(\d+)\s*x\s*(\d+)/);
      if (match) return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    } else {
      // Linux
      if (process.env.DISPLAY) {
        const output = execSync("xdpyinfo 2>/dev/null | grep dimensions", { encoding: "utf8", timeout: 3000 });
        const match = output.match(/(\d+)x(\d+)/);
        if (match) return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
      }
    }
  } catch (e: any) {
    warnings.push(`screen_probe_failed: ${e?.message ?? "unknown"}`);
  }
  return null;
}

function probeNetwork(): { hasNetwork: boolean; interfaceCount: number } {
  const interfaces = os.networkInterfaces();
  let count = 0;
  let hasNonLoopback = false;
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal) {
        hasNonLoopback = true;
        count++;
      }
    }
  }
  return { hasNetwork: hasNonLoopback, interfaceCount: count };
}
