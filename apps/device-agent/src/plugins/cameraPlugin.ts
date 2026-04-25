/**
 * Camera Plugin — 摄像头 I/O 抽象插件
 *
 * 跨平台摄像头采集：探测可用后端 → 拍摄单帧 → 返回 base64。
 * 支持平台：Windows（ffmpeg/dshow）、macOS（ffmpeg/avfoundation、imagesnap）、Linux（ffmpeg/v4l2、fswebcam）
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CapabilityDescriptor } from "../kernel";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";
import { commandExists, runProcess } from "./pluginUtils";

// ── 状态 ─────────────────────────────────────────────────────────

type CameraBackend = "ffmpeg" | "fswebcam" | "imagesnap" | "none";

let _backend: CameraBackend = "none";
let _ffmpegInputFormat = "";
let _tmpFiles: string[] = [];

// ── 辅助 ─────────────────────────────────────────────────────────

function tmpFile(ext: string): string {
  const p = path.join(os.tmpdir(), `cam_${crypto.randomUUID()}.${ext}`);
  _tmpFiles.push(p);
  return p;
}

async function removeTmpFile(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
  _tmpFiles = _tmpFiles.filter((f) => f !== filePath);
}

async function checkDevVideo(): Promise<string[]> {
  try {
    const entries = await fs.readdir("/dev");
    return entries.filter((e) => e.startsWith("video")).map((e) => `/dev/${e}`);
  } catch {
    return [];
  }
}

// ── 探测 ─────────────────────────────────────────────────────────

async function probeBackend(): Promise<CameraBackend> {
  const plat = process.platform;
  const hasFFmpeg = await commandExists("ffmpeg");

  if (plat === "win32") {
    if (hasFFmpeg) { _ffmpegInputFormat = "dshow"; return "ffmpeg"; }
    // PowerShell + DirectShow 不直接支持摄像头帧采集，降级为 none
    return "none";
  }

  if (plat === "darwin") {
    if (hasFFmpeg) { _ffmpegInputFormat = "avfoundation"; return "ffmpeg"; }
    if (await commandExists("imagesnap")) return "imagesnap";
    return "none";
  }

  // Linux
  if (hasFFmpeg) { _ffmpegInputFormat = "v4l2"; return "ffmpeg"; }
  if (await commandExists("fswebcam")) return "fswebcam";
  const devs = await checkDevVideo();
  if (devs.length > 0 && hasFFmpeg) { _ffmpegInputFormat = "v4l2"; return "ffmpeg"; }
  return "none";
}

// ── device.camera.devices ────────────────────────────────────────

interface CameraDeviceInfo {
  index: number;
  name: string;
  path?: string;
}

async function listDevices(): Promise<CameraDeviceInfo[]> {
  const plat = process.platform;

  if (plat === "win32" && _backend === "ffmpeg") {
    const r = await runProcess("ffmpeg", ["-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    // ffmpeg 在 stderr 输出设备列表
    const combined = r.stdout + "\n" + r.stderr;
    const devices: CameraDeviceInfo[] = [];
    let idx = 0;
    for (const line of combined.split("\n")) {
      // 匹配 "DirectShow video devices" 下的 "[dshow ...] \"<name>\""
      const m = line.match(/\[dshow\s.*?\]\s+"([^"]+)"/);
      if (m) {
        // 排除音频设备：跳过 "DirectShow audio devices" 之后的条目
        if (/audio devices/i.test(combined.slice(0, combined.indexOf(line)))) continue;
        devices.push({ index: idx++, name: m[1] });
      }
    }
    return devices;
  }

  if (plat === "darwin" && _backend === "ffmpeg") {
    const r = await runProcess("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    const combined = r.stdout + "\n" + r.stderr;
    const devices: CameraDeviceInfo[] = [];
    let inVideo = false;
    for (const line of combined.split("\n")) {
      if (/AVFoundation video devices/i.test(line)) { inVideo = true; continue; }
      if (/AVFoundation audio devices/i.test(line)) { inVideo = false; continue; }
      if (!inVideo) continue;
      const m = line.match(/\[(\d+)]\s+(.+)/);
      if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
    }
    return devices;
  }

  if (plat === "linux") {
    // v4l2-ctl 优先
    const hasV4l2 = await commandExists("v4l2-ctl");
    if (hasV4l2) {
      const r = await runProcess("v4l2-ctl", ["--list-devices"]);
      if (r.code === 0) {
        const devices: CameraDeviceInfo[] = [];
        let currentName = "";
        let idx = 0;
        for (const line of r.stdout.split("\n")) {
          const headerMatch = line.match(/^(.+)\s+\(.+\):/);
          if (headerMatch) { currentName = headerMatch[1].trim(); continue; }
          const devMatch = line.match(/^\s+(\/dev\/video\d+)/);
          if (devMatch) {
            devices.push({ index: idx++, name: currentName || `camera_${idx}`, path: devMatch[1] });
          }
        }
        return devices;
      }
    }
    // 回退：列出 /dev/video*
    const devs = await checkDevVideo();
    return devs.map((d, i) => ({ index: i, name: path.basename(d), path: d }));
  }

  return [];
}

async function execDevices(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  try {
    const devices = await listDevices();
    return { status: "succeeded", outputDigest: { devices } };
  } catch (e: any) {
    console.error("[camera] listDevices failed:", e?.message);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "list_devices_failed", detail: e?.message } };
  }
}

// ── device.camera.capture ────────────────────────────────────────

interface CaptureInput {
  deviceIndex?: number;
  width?: number;
  height?: number;
  format?: "jpeg" | "png";
}

async function getDeviceIdentifier(deviceIndex: number): Promise<string> {
  const plat = process.platform;
  if (plat === "win32") {
    // dshow 需要设备名称
    const devices = await listDevices();
    const dev = devices.find((d) => d.index === deviceIndex);
    return dev ? `video=${dev.name}` : `video=0`;
  }
  if (plat === "darwin") {
    return String(deviceIndex);
  }
  // Linux
  return `/dev/video${deviceIndex}`;
}

async function captureFFmpeg(input: CaptureInput): Promise<{ filePath: string; width: number; height: number; format: string }> {
  const idx = input.deviceIndex ?? 0;
  const w = input.width ?? 640;
  const h = input.height ?? 480;
  const fmt = input.format ?? "jpeg";
  const ext = fmt === "png" ? "png" : "jpg";
  const outFile = tmpFile(ext);

  const device = await getDeviceIdentifier(idx);
  const codecArg = fmt === "png" ? "png" : "mjpeg";

  const args = [
    "-f", _ffmpegInputFormat,
    "-i", device,
    "-vframes", "1",
    "-s", `${w}x${h}`,
    "-c:v", codecArg,
    "-y",
    outFile,
  ];

  const r = await runProcess("ffmpeg", args);
  if (r.code !== 0) {
    await removeTmpFile(outFile);
    throw new Error(`ffmpeg_capture_failed: exit ${r.code} — ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  return { filePath: outFile, width: w, height: h, format: fmt };
}

async function captureFswebcam(input: CaptureInput): Promise<{ filePath: string; width: number; height: number; format: string }> {
  const idx = input.deviceIndex ?? 0;
  const w = input.width ?? 640;
  const h = input.height ?? 480;
  const fmt = input.format ?? "jpeg";
  const ext = fmt === "png" ? "png" : "jpg";
  const outFile = tmpFile(ext);

  const args = [
    "-d", `/dev/video${idx}`,
    "-r", `${w}x${h}`,
    ...(fmt === "jpeg" ? ["--jpeg", "85"] : ["--png", "9"]),
    outFile,
  ];

  const r = await runProcess("fswebcam", args);
  if (r.code !== 0) {
    await removeTmpFile(outFile);
    throw new Error(`fswebcam_capture_failed: exit ${r.code}`);
  }
  return { filePath: outFile, width: w, height: h, format: fmt };
}

async function captureImagesnap(input: CaptureInput): Promise<{ filePath: string; width: number; height: number; format: string }> {
  const idx = input.deviceIndex ?? 0;
  const fmt = input.format ?? "jpeg";
  const ext = fmt === "png" ? "png" : "jpg";
  const outFile = tmpFile(ext);

  const args = ["-d", String(idx), outFile];
  const r = await runProcess("imagesnap", args);
  if (r.code !== 0) {
    await removeTmpFile(outFile);
    throw new Error(`imagesnap_capture_failed: exit ${r.code}`);
  }
  return { filePath: outFile, width: input.width ?? 640, height: input.height ?? 480, format: fmt };
}

async function execCapture(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (_backend === "none") {
    return { status: "failed", errorCategory: "device_unavailable", outputDigest: { reason: "no_camera_backend" } };
  }

  const input: CaptureInput = {
    deviceIndex: ctx.input.deviceIndex ?? 0,
    width: ctx.input.width,
    height: ctx.input.height,
    format: ctx.input.format ?? "jpeg",
  };

  try {
    let result: { filePath: string; width: number; height: number; format: string };

    if (_backend === "ffmpeg") {
      result = await captureFFmpeg(input);
    } else if (_backend === "fswebcam") {
      result = await captureFswebcam(input);
    } else if (_backend === "imagesnap") {
      result = await captureImagesnap(input);
    } else {
      return { status: "failed", errorCategory: "device_unavailable", outputDigest: { reason: "unknown_backend" } };
    }

    const buf = await fs.readFile(result.filePath);
    const base64 = buf.toString("base64");

    return {
      status: "succeeded",
      outputDigest: {
        filePath: result.filePath,
        base64,
        width: result.width,
        height: result.height,
        format: result.format,
      },
    };
  } catch (e: any) {
    console.error("[camera] capture failed:", e?.message);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "capture_failed", detail: e?.message } };
  }
}

// ── 路由表 ───────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.camera.capture": execCapture,
  "device.camera.devices": execDevices,
};

// ── 能力声明 ─────────────────────────────────────────────────────

const CAMERA_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.camera.capture", riskLevel: "medium", description: "从摄像头拍摄一帧图像" },
  { toolRef: "device.camera.devices", riskLevel: "low", description: "列出摄像头设备" },
];

// ── 导出插件实例 ─────────────────────────────────────────────────

const cameraPlugin: DeviceToolPlugin = {
  name: "camera",
  version: "1.0.0",
  source: "builtin",
  toolPrefixes: ["device.camera.*"],
  toolNames: ["device.camera.capture", "device.camera.devices"],
  capabilities: CAMERA_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 40, maxCpuPercent: 15 },
  deviceTypeResourceProfiles: {
    iot: { maxMemoryMb: 20, maxCpuPercent: 10 },
    robot: { maxMemoryMb: 20, maxCpuPercent: 10 },
    vehicle: { maxMemoryMb: 20, maxCpuPercent: 10 },
    home: { maxMemoryMb: 20, maxCpuPercent: 10 },
  },

  async init() {
    _backend = await probeBackend();
    if (_backend === "none") {
      console.warn("[camera] no camera backend detected");
    } else {
      console.warn(`[camera] backend=${_backend} inputFormat=${_ffmpegInputFormat || "n/a"}`);
    }
  },

  async healthcheck() {
    const devices = _backend !== "none" ? await listDevices().catch(() => []) : [];
    return {
      healthy: _backend !== "none",
      details: {
        cameraAvailable: _backend !== "none",
        backend: _backend,
        deviceCount: devices.length,
      },
    };
  },

  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "camera" } };
    return handler(ctx);
  },

  async dispose() {
    const files = [..._tmpFiles];
    _tmpFiles = [];
    for (const f of files) {
      await fs.unlink(f).catch(() => {});
    }
    _backend = "none";
    _ffmpegInputFormat = "";
  },
};

export default cameraPlugin;
