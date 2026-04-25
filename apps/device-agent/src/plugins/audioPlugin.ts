/**
 * Audio I/O 抽象插件 — 处理 device.audio.capture / device.audio.play / device.audio.devices
 *
 * 跨平台音频采集与播放，探测优先级：
 *   Windows: ffmpeg → PowerShell [System.Media.SoundPlayer]
 *   macOS:   ffmpeg → afrecord/afplay
 *   Linux:   ffmpeg → arecord/aplay (ALSA) → parecord/paplay (PulseAudio)
 */
import { ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CapabilityDescriptor } from "../kernel";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";
import { commandExists, runProcess, runPowerShell, runPowerShellJson } from "./pluginUtils";

// ── 类型定义 ──────────────────────────────────────────────────────

type AudioBackend = "ffmpeg" | "powershell" | "afrecord" | "arecord" | "parecord" | "none";
type PlaybackBackend = "ffmpeg" | "powershell" | "afplay" | "aplay" | "paplay" | "none";

interface ProbeResult {
  captureBackend: AudioBackend;
  playbackBackend: PlaybackBackend;
}

// ── 状态 ──────────────────────────────────────────────────────────

let _probe: ProbeResult = { captureBackend: "none", playbackBackend: "none" };
const _tmpFiles: Set<string> = new Set();

// ── 流式音频状态 ─────────────────────────────────────────────────

let streamProcess: ChildProcess | null = null;
let streamBuffer: Buffer[] = [];
const MAX_BUFFER_CHUNKS = 30; // 保留最近30个chunk（约30秒@1秒/chunk）
let streamActive = false;
let streamSampleRate = 16000;
let streamChannels = 1;

// ── 临时文件管理 ──────────────────────────────────────────────────

function tmpAudio(ext: string): string {
  const p = path.join(os.tmpdir(), `audio_${crypto.randomUUID()}.${ext}`);
  _tmpFiles.add(p);
  return p;
}

async function cleanupTmpFiles(): Promise<void> {
  for (const f of _tmpFiles) {
    await fs.unlink(f).catch(() => {});
  }
  _tmpFiles.clear();
}

// ── 跨平台探测 ───────────────────────────────────────────────────

async function probeBackends(): Promise<ProbeResult> {
  const platform = process.platform;
  let captureBackend: AudioBackend = "none";
  let playbackBackend: PlaybackBackend = "none";

  // 所有平台优先探测 ffmpeg
  if (await commandExists("ffmpeg")) {
    captureBackend = "ffmpeg";
    playbackBackend = "ffmpeg";
    return { captureBackend, playbackBackend };
  }

  if (platform === "win32") {
    // PowerShell 始终可用
    captureBackend = "none"; // Windows 无内置 CLI 录音，仅 ffmpeg 可录
    playbackBackend = "powershell";
  } else if (platform === "darwin") {
    if (await commandExists("afrecord")) captureBackend = "afrecord";
    playbackBackend = (await commandExists("afplay")) ? "afplay" : "none";
  } else {
    // Linux: ALSA → PulseAudio
    if (await commandExists("arecord")) {
      captureBackend = "arecord";
    } else if (await commandExists("parecord")) {
      captureBackend = "parecord";
    }
    if (await commandExists("aplay")) {
      playbackBackend = "aplay";
    } else if (await commandExists("paplay")) {
      playbackBackend = "paplay";
    }
  }

  return { captureBackend, playbackBackend };
}

// ── device.audio.capture 实现 ────────────────────────────────────

async function execAudioCapture(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const durationMs: number = Number(ctx.input.durationMs ?? 5000);
  const format: string = String(ctx.input.format ?? "wav");
  const sampleRate: number = Number(ctx.input.sampleRate ?? 16000);
  const channels: number = Number(ctx.input.channels ?? 1);
  const durationSec: number = Math.max(0.1, durationMs / 1000);

  if (_probe.captureBackend === "none") {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_capture_backend_available" } };
  }

  const outFile: string = tmpAudio(format);

  try {
    if (_probe.captureBackend === "ffmpeg") {
      const inputArgs: string[] = process.platform === "win32"
        ? ["-f", "dshow", "-i", "audio=default"]
        : process.platform === "darwin"
          ? ["-f", "avfoundation", "-i", ":default"]
          : ["-f", "pulse", "-i", "default"];

      const result = await runProcess("ffmpeg", [
        "-y", ...inputArgs,
        "-t", String(durationSec),
        "-ar", String(sampleRate),
        "-ac", String(channels),
        outFile,
      ]);
      if (result.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "ffmpeg_capture_failed", stderr: result.stderr.slice(0, 500) } };
      }
    } else if (_probe.captureBackend === "afrecord") {
      // macOS afrecord
      const fmtFlag: string = format === "mp3" ? "mp3f" : format === "pcm" ? "LEI16" : "WAVE";
      const result = await runProcess("afrecord", [
        "-f", fmtFlag, "-c", String(channels), "-r", String(sampleRate),
        "-d", String(durationSec), outFile,
      ]);
      if (result.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "afrecord_failed", stderr: result.stderr.slice(0, 500) } };
      }
    } else if (_probe.captureBackend === "arecord") {
      // Linux ALSA
      const fmtFlag: string = format === "wav" ? "wav" : "raw";
      const result = await runProcess("arecord", [
        "-f", "S16_LE", "-r", String(sampleRate), "-c", String(channels),
        "-t", fmtFlag, "-d", String(Math.ceil(durationSec)), outFile,
      ]);
      if (result.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "arecord_failed", stderr: result.stderr.slice(0, 500) } };
      }
    } else if (_probe.captureBackend === "parecord") {
      // Linux PulseAudio
      const result = await runProcess("parecord", [
        "--channels", String(channels), "--rate", String(sampleRate),
        "--format", "s16le", outFile,
      ]);
      // parecord 需要手动停止；这里用 timeout 方式借助 runProcess 超时
      if (result.code !== 0 && result.code !== 1) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "parecord_failed", stderr: result.stderr.slice(0, 500) } };
      }
    }

    const buf: Buffer = await fs.readFile(outFile);
    const base64: string = buf.toString("base64");

    return {
      status: "succeeded",
      outputDigest: { filePath: outFile, base64, durationMs, format },
    };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "capture_exception", message: err?.message?.slice(0, 300) } };
  }
}

// ── device.audio.play 实现 ───────────────────────────────────────

async function execAudioPlay(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const filePath: string | undefined = ctx.input.filePath ? String(ctx.input.filePath) : undefined;
  const base64: string | undefined = ctx.input.base64 ? String(ctx.input.base64) : undefined;
  const url: string | undefined = ctx.input.url ? String(ctx.input.url) : undefined;
  const format: string = String(ctx.input.format ?? "wav");

  if (_probe.playbackBackend === "none") {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_playback_backend_available" } };
  }

  let targetFile: string | undefined = filePath;

  try {
    // base64 → 写入临时文件
    if (!targetFile && base64) {
      targetFile = tmpAudio(format);
      await fs.writeFile(targetFile, Buffer.from(base64, "base64"));
    }
    // url → 用 ffmpeg 直接播放（仅 ffmpeg 支持 url）
    if (!targetFile && url) {
      if (_probe.playbackBackend === "ffmpeg") {
        targetFile = url; // ffmpeg 可直接播放 url
      } else {
        return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "url_playback_requires_ffmpeg" } };
      }
    }

    if (!targetFile) {
      return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "no_audio_source_provided" } };
    }

    const startMs: number = Date.now();

    if (_probe.playbackBackend === "ffmpeg") {
      const result = await runProcess("ffmpeg", ["-y", "-i", targetFile, "-f", "null", "-"]);
      // ffplay 可能不存在，直接用 ffmpeg decode 验证；尝试 ffplay
      const ffplayExists: boolean = await commandExists("ffplay");
      if (ffplayExists) {
        const playResult = await runProcess("ffplay", ["-nodisp", "-autoexit", targetFile]);
        if (playResult.code !== 0) {
          return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "ffplay_failed", stderr: playResult.stderr.slice(0, 500) } };
        }
      } else if (result.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "ffmpeg_play_failed" } };
      }
    } else if (_probe.playbackBackend === "powershell") {
      const escaped: string = targetFile.replaceAll("'", "''");
      await runPowerShell(`(New-Object System.Media.SoundPlayer '${escaped}').PlaySync()`);
    } else if (_probe.playbackBackend === "afplay") {
      const result = await runProcess("afplay", [targetFile]);
      if (result.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "afplay_failed", stderr: result.stderr.slice(0, 500) } };
      }
    } else if (_probe.playbackBackend === "aplay") {
      const result = await runProcess("aplay", [targetFile]);
      if (result.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "aplay_failed", stderr: result.stderr.slice(0, 500) } };
      }
    } else if (_probe.playbackBackend === "paplay") {
      const result = await runProcess("paplay", [targetFile]);
      if (result.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "paplay_failed", stderr: result.stderr.slice(0, 500) } };
      }
    }

    const durationMs: number = Date.now() - startMs;
    return { status: "succeeded", outputDigest: { played: true, durationMs } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "play_exception", message: err?.message?.slice(0, 300) } };
  }
}

// ── device.audio.devices 实现 ────────────────────────────────────

interface AudioDeviceInfo {
  id: string;
  name: string;
  type: "input" | "output";
}

async function execAudioDevices(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const devices: AudioDeviceInfo[] = [];

  try {
    if (process.platform === "win32") {
      const result = await runPowerShellJson<Array<{ DeviceID?: string; Name?: string; StatusInfo?: number }> | null>(
        "Get-CimInstance Win32_SoundDevice | Select-Object DeviceID, Name, StatusInfo | ConvertTo-Json -Compress",
      );
      const raw: Array<{ DeviceID?: string; Name?: string; StatusInfo?: number }> = Array.isArray(result) ? result : result ? [result] : [];
      for (const d of raw) {
        devices.push({
          id: String(d.DeviceID ?? "unknown"),
          name: String(d.Name ?? "Unknown Device"),
          type: "output", // Win32_SoundDevice 不区分方向，默认 output
        });
      }
    } else if (process.platform === "darwin") {
      const result = await runProcess("system_profiler", ["SPAudioDataType", "-json"]);
      if (result.code === 0) {
        try {
          const data: any = JSON.parse(result.stdout);
          const audioItems: any[] = data?.SPAudioDataType ?? [];
          for (const item of audioItems) {
            const items: any[] = item?._items ?? [];
            for (const dev of items) {
              devices.push({
                id: String(dev._name ?? "unknown"),
                name: String(dev._name ?? "Unknown Device"),
                type: String(dev.coreaudio_default_audio_input_device ?? "").toLowerCase() === "yes" ? "input" : "output",
              });
            }
          }
        } catch {
          // JSON 解析失败，返回空
        }
      }
    } else {
      // Linux: arecord -l + aplay -l 或 pactl
      if (await commandExists("arecord")) {
        const recResult = await runProcess("arecord", ["-l"]);
        if (recResult.code === 0) {
          for (const line of recResult.stdout.split("\n")) {
            const m: RegExpMatchArray | null = line.match(/card\s+(\d+).*:\s*(.+)\[/);
            if (m) devices.push({ id: `hw:${m[1]}`, name: m[2].trim(), type: "input" });
          }
        }
      }
      if (await commandExists("aplay")) {
        const playResult = await runProcess("aplay", ["-l"]);
        if (playResult.code === 0) {
          for (const line of playResult.stdout.split("\n")) {
            const m: RegExpMatchArray | null = line.match(/card\s+(\d+).*:\s*(.+)\[/);
            if (m) devices.push({ id: `hw:${m[1]}`, name: m[2].trim(), type: "output" });
          }
        }
      }
      // PulseAudio fallback
      if (devices.length === 0 && await commandExists("pactl")) {
        const srcResult = await runProcess("pactl", ["list", "sources", "short"]);
        if (srcResult.code === 0) {
          for (const line of srcResult.stdout.split("\n").filter(Boolean)) {
            const parts: string[] = line.split("\t");
            if (parts.length >= 2) devices.push({ id: parts[0], name: parts[1], type: "input" });
          }
        }
        const sinkResult = await runProcess("pactl", ["list", "sinks", "short"]);
        if (sinkResult.code === 0) {
          for (const line of sinkResult.stdout.split("\n").filter(Boolean)) {
            const parts: string[] = line.split("\t");
            if (parts.length >= 2) devices.push({ id: parts[0], name: parts[1], type: "output" });
          }
        }
      }
    }

    return { status: "succeeded", outputDigest: { devices } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "device_list_failed", message: err?.message?.slice(0, 300) } };
  }
}

// ── 流式音频工具实现 ─────────────────────────────────────────────

async function handleStreamStart(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const sampleRate = Number(ctx.input.sampleRate ?? 16000);
  const channels = Number(ctx.input.channels ?? 1);
  const chunkMs = Number(ctx.input.chunkMs ?? 1000);

  if (_probe.captureBackend === "none") {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_capture_backend_available" } };
  }

  // 如果已有流进程，先停止
  if (streamProcess) {
    streamProcess.kill();
    streamProcess = null;
    streamBuffer = [];
    streamActive = false;
  }

  const chunkBytes = Math.floor((sampleRate * channels * 2 * chunkMs) / 1000); // S16_LE = 2 bytes/sample
  let cmd: string;
  let args: string[];

  if (_probe.captureBackend === "ffmpeg") {
    const inputArgs: string[] = process.platform === "win32"
      ? ["-f", "dshow", "-i", "audio=default"]
      : process.platform === "darwin"
        ? ["-f", "avfoundation", "-i", ":default"]
        : ["-f", "pulse", "-i", "default"];
    cmd = "ffmpeg";
    args = [...inputArgs, "-ar", String(sampleRate), "-ac", String(channels), "-f", "s16le", "pipe:1"];
  } else if (_probe.captureBackend === "arecord") {
    cmd = "arecord";
    args = ["-f", "S16_LE", "-r", String(sampleRate), "-c", String(channels), "-t", "raw", "-"];
  } else if (_probe.captureBackend === "parecord") {
    cmd = "parecord";
    args = ["--format=s16le", `--rate=${sampleRate}`, `--channels=${channels}`, "--raw"];
  } else {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "streaming_not_supported_for_backend", backend: _probe.captureBackend } };
  }

  try {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    streamProcess = child;
    streamBuffer = [];
    streamActive = true;
    streamSampleRate = sampleRate;
    streamChannels = channels;

    let pendingData = Buffer.alloc(0);

    child.stdout!.on("data", (data: Buffer) => {
      pendingData = Buffer.concat([pendingData, data]);
      while (pendingData.length >= chunkBytes) {
        const chunk = pendingData.subarray(0, chunkBytes);
        pendingData = pendingData.subarray(chunkBytes);
        streamBuffer.push(Buffer.from(chunk));
        if (streamBuffer.length > MAX_BUFFER_CHUNKS) {
          streamBuffer.shift();
        }
      }
    });

    child.on("close", () => {
      streamActive = false;
      streamProcess = null;
    });

    child.on("error", () => {
      streamActive = false;
      streamProcess = null;
    });

    return { status: "succeeded", outputDigest: { started: true, sampleRate, channels, chunkMs } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "stream_start_exception", message: err?.message?.slice(0, 300) } };
  }
}

async function handleStreamRead(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!streamActive) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "stream_not_active" } };
  }

  const chunks = Math.max(1, Number(ctx.input.chunks ?? 1));
  const encoding: "base64" | "hex" = (ctx.input.encoding === "hex" ? "hex" : "base64") as "base64" | "hex";

  const selected = streamBuffer.slice(-chunks);
  if (selected.length === 0) {
    return { status: "succeeded", outputDigest: { data: "", encoding, chunks: 0, totalBytes: 0, sampleRate: streamSampleRate, format: "pcm_s16le" } };
  }

  const merged = Buffer.concat(selected);
  return {
    status: "succeeded",
    outputDigest: {
      data: merged.toString(encoding),
      encoding,
      chunks: selected.length,
      totalBytes: merged.length,
      sampleRate: streamSampleRate,
      format: "pcm_s16le",
    },
  };
}

async function handleStreamStop(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (streamProcess) {
    streamProcess.kill();
  }
  streamProcess = null;
  streamBuffer = [];
  streamActive = false;

  return { status: "succeeded", outputDigest: { stopped: true } };
}

// ── 路由表 ────────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.audio.capture": execAudioCapture,
  "device.audio.play": execAudioPlay,
  "device.audio.devices": execAudioDevices,
  "device.audio.stream_start": handleStreamStart,
  "device.audio.stream_read": handleStreamRead,
  "device.audio.stream_stop": handleStreamStop,
};

// ── 能力声明 ──────────────────────────────────────────────────────

const AUDIO_CAPABILITIES: CapabilityDescriptor[] = [
  {
    toolRef: "device.audio.capture",
    riskLevel: "medium",
    description: "从麦克风录制音频",
    version: "1.0.0",
    tags: ["audio", "capture"],
  },
  {
    toolRef: "device.audio.play",
    riskLevel: "low",
    description: "播放音频",
    version: "1.0.0",
    tags: ["audio", "playback"],
  },
  {
    toolRef: "device.audio.devices",
    riskLevel: "low",
    description: "列出音频设备",
    version: "1.0.0",
    tags: ["audio", "devices"],
  },
  {
    toolRef: "device.audio.stream_start",
    riskLevel: "medium",
    description: "开始持续音频流采集",
    tags: ["audio", "streaming"],
    version: "1.0.0",
  },
  {
    toolRef: "device.audio.stream_read",
    riskLevel: "low",
    description: "读取音频流缓冲区数据",
    tags: ["audio", "streaming"],
    version: "1.0.0",
  },
  {
    toolRef: "device.audio.stream_stop",
    riskLevel: "low",
    description: "停止音频流采集",
    tags: ["audio", "streaming"],
    version: "1.0.0",
  },
];

// ── 导出插件实例 ──────────────────────────────────────────────────

const audioPlugin: DeviceToolPlugin = {
  name: "audio",
  version: "1.0.0",
  source: "builtin",
  toolPrefixes: ["device.audio.*"],
  toolNames: ["device.audio.capture", "device.audio.play", "device.audio.devices", "device.audio.stream_start", "device.audio.stream_read", "device.audio.stream_stop"],
  capabilities: AUDIO_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 50, maxCpuPercent: 15 },
  deviceTypeResourceProfiles: {
    iot: { maxMemoryMb: 20, maxCpuPercent: 10 },
    robot: { maxMemoryMb: 20, maxCpuPercent: 10 },
    vehicle: { maxMemoryMb: 20, maxCpuPercent: 10 },
    home: { maxMemoryMb: 20, maxCpuPercent: 10 },
  },

  async init(): Promise<void> {
    console.warn("[audio] probing audio backends...");
    _probe = await probeBackends();
    console.warn(`[audio] capture=${_probe.captureBackend}, playback=${_probe.playbackBackend}`);
  },

  async healthcheck(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
    const captureAvailable: boolean = _probe.captureBackend !== "none";
    const playbackAvailable: boolean = _probe.playbackBackend !== "none";
    return {
      healthy: captureAvailable || playbackAvailable,
      details: {
        captureAvailable,
        playbackAvailable,
        backend: { capture: _probe.captureBackend, playback: _probe.playbackBackend },
      },
    };
  },

  async execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "audio" } };
    }
    return handler(ctx);
  },

  async dispose(): Promise<void> {
    console.warn("[audio] cleaning up temporary files...");
    if (streamProcess) {
      streamProcess.kill();
      streamProcess = null;
      streamBuffer = [];
      streamActive = false;
    }
    await cleanupTmpFiles();
  },
};

export default audioPlugin;
