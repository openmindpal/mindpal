/**
 * Dialog Engine Plugin — 对话编排引擎
 *
 * 实现语音对话闭环：VAD → STT → Agent Loop → TTS
 * 状态机：idle → listening → detecting → transcribing → thinking → speaking → listening
 *
 * @layer plugin
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";

import type {
  DeviceToolPlugin,
  ToolExecutionContext,
  ToolExecutionResult,
  DeviceMessageContext,
} from "../pluginRegistry";
import type { CapabilityDescriptor } from "../kernel/types";
import { findPluginForTool } from "../kernel/capabilityRegistry";

// ── 类型定义 ──────────────────────────────────────────────────────

type DialogState = "idle" | "listening" | "detecting" | "transcribing" | "thinking" | "speaking";

// ── 内部状态 ──────────────────────────────────────────────────────

let dialogState: DialogState = "idle";
let idleCounter = 0;
let vadThreshold = Number(process.env.DEVICE_AGENT_VAD_THRESHOLD) || 500;
let idleTimeoutMs = Number(process.env.DEVICE_AGENT_DIALOG_IDLE_TIMEOUT_MS) || 60000;
let responseTimeoutMs = 15000;
const captureIntervalMs = 3000;

let pendingResponse: { resolve: (text: string) => void } | null = null;

// ── VAD 实现（零依赖，纯计算） ────────────────────────────────────

function detectVoiceActivity(pcmBuffer: Buffer, threshold: number): boolean {
  if (!pcmBuffer || pcmBuffer.length < 2) return false;
  let sumSquares = 0;
  const sampleCount = pcmBuffer.length / 2;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms > threshold;
}

// ── 辅助函数 ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(
      parsed,
      { method: options.method, headers: options.headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── 音频采集 ──────────────────────────────────────────────────────

async function captureShortAudio(): Promise<{ filePath: string; base64: string; pcmBuffer: Buffer }> {
  const audioPlugin = findPluginForTool("device.audio.capture");
  if (!audioPlugin) throw new Error("audio plugin not available");

  const result = await audioPlugin.execute({
    toolName: "device.audio.capture",
    input: { durationMs: captureIntervalMs, format: "wav", sampleRate: 16000, channels: 1 },
    cfg: { apiBase: "", deviceToken: "" },
    execution: { deviceExecutionId: "dialog-capture", toolRef: "device.audio.capture" },
    policy: null,
    requireUserPresence: false,
    confirmFn: async () => true,
  } as ToolExecutionContext);

  if (result.status !== "succeeded" || !result.outputDigest) {
    throw new Error("audio capture failed");
  }

  const digest = result.outputDigest as Record<string, any>;
  const filePath: string = digest.filePath ?? "";
  const base64: string = digest.base64 ?? "";

  // 从 wav 文件读取 PCM 数据（跳过 44 字节 WAV 头）
  let pcmBuffer: Buffer;
  try {
    const wavBuf = await fs.readFile(filePath);
    pcmBuffer = wavBuf.subarray(44);
  } catch {
    pcmBuffer = Buffer.from(base64, "base64").subarray(44);
  }

  return { filePath, base64, pcmBuffer };
}

// ── 云端通信 ──────────────────────────────────────────────────────

async function sendAudioForTranscription(
  cfg: { apiBase: string; deviceToken: string },
  audio: { base64: string },
): Promise<string | null> {
  try {
    const resp = await httpRequest(`${cfg.apiBase}/device-agent/dialog/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.deviceToken}`,
      },
      body: JSON.stringify({ audioBase64: audio.base64, format: "wav", sampleRate: 16000 }),
    });
    if (resp.statusCode !== 200) return null;
    const data = JSON.parse(resp.body);
    return typeof data.transcript === "string" && data.transcript.trim() ? data.transcript.trim() : null;
  } catch (err: any) {
    console.error("[dialogEngine] transcription request failed:", err?.message);
    return null;
  }
}

async function sendMessageToCloud(
  cfg: { apiBase: string; deviceToken: string },
  text: string,
): Promise<void> {
  try {
    await httpRequest(`${cfg.apiBase}/device-agent/dialog/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.deviceToken}`,
      },
      body: JSON.stringify({ text, source: "voice" }),
    });
  } catch (err: any) {
    console.error("[dialogEngine] send message failed:", err?.message);
  }
}

async function requestTts(
  cfg: { apiBase: string; deviceToken: string },
  text: string,
): Promise<string | null> {
  try {
    const resp = await httpRequest(`${cfg.apiBase}/device-agent/dialog/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.deviceToken}`,
      },
      body: JSON.stringify({ text }),
    });
    if (resp.statusCode !== 200) return null;
    const data = JSON.parse(resp.body);
    return typeof data.audioBase64 === "string" ? data.audioBase64 : null;
  } catch (err: any) {
    console.error("[dialogEngine] tts request failed:", err?.message);
    return null;
  }
}

// ── 云端回复接收 ──────────────────────────────────────────────────

function waitForResponse(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    pendingResponse = { resolve: resolve as (text: string) => void };
    setTimeout(() => {
      pendingResponse = null;
      resolve(null);
    }, timeoutMs);
  });
}

// ── TTS 播放 ──────────────────────────────────────────────────────

async function playTtsAudio(
  cfg: { apiBase: string; deviceToken: string },
  text: string,
): Promise<void> {
  const ttsBase64 = await requestTts(cfg, text);
  if (!ttsBase64) return;
  const audioPlugin = findPluginForTool("device.audio.play");
  if (!audioPlugin) return;
  await audioPlugin.execute({
    toolName: "device.audio.play",
    input: { base64: ttsBase64, format: "wav" },
    cfg: { apiBase: "", deviceToken: "" },
    execution: { deviceExecutionId: "dialog-tts", toolRef: "device.audio.play" },
    policy: null,
    requireUserPresence: false,
    confirmFn: async () => true,
  } as ToolExecutionContext);
}

// ── 对话循环 ──────────────────────────────────────────────────────

async function dialogLoop(cfg: { apiBase: string; deviceToken: string }): Promise<void> {
  while (dialogState !== "idle") {
    try {
      // 1. listening: 录制短片段
      dialogState = "listening";
      const audioResult = await captureShortAudio();

      // 2. detecting: VAD检测
      dialogState = "detecting";
      const hasVoice = detectVoiceActivity(audioResult.pcmBuffer, vadThreshold);
      if (!hasVoice) {
        idleCounter += captureIntervalMs;
        if (idleCounter > idleTimeoutMs) {
          dialogState = "idle";
          console.warn("[dialogEngine] idle timeout, stopping dialog loop");
          break;
        }
        continue;
      }
      idleCounter = 0;

      // 3. transcribing: 上报音频到云端STT
      dialogState = "transcribing";
      const transcript = await sendAudioForTranscription(cfg, audioResult);
      if (!transcript) continue;

      // 4. thinking: 发送文本到云端Agent Loop
      dialogState = "thinking";
      await sendMessageToCloud(cfg, transcript);

      // 5. speaking: 等待云端回复，TTS播放
      dialogState = "speaking";
      const response = await waitForResponse(responseTimeoutMs);
      if (response) {
        await playTtsAudio(cfg, response);
      }
    } catch (err: any) {
      console.error("[dialogEngine] loop error:", err?.message);
      await sleep(1000);
    }
  }
}

// ── 能力声明 ──────────────────────────────────────────────────────

const DIALOG_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.dialog.start", riskLevel: "medium", description: "启动对话模式" },
  { toolRef: "device.dialog.stop", riskLevel: "low", description: "停止对话模式" },
  { toolRef: "device.dialog.status", riskLevel: "low", description: "查看对话引擎状态" },
  { toolRef: "device.dialog.say", riskLevel: "low", description: "TTS播放一句话" },
];

// ── execute 路由 ─────────────────────────────────────────────────

async function execDialogStart(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (dialogState !== "idle") {
    return { status: "failed", errorCategory: "invalid_state", outputDigest: { reason: "dialog_already_running", state: dialogState } };
  }

  const input = ctx.input ?? {};
  if (typeof input.vadThreshold === "number") vadThreshold = input.vadThreshold;
  if (typeof input.idleTimeoutMs === "number") idleTimeoutMs = input.idleTimeoutMs;
  if (typeof input.responseTimeoutMs === "number") responseTimeoutMs = input.responseTimeoutMs;

  idleCounter = 0;
  dialogState = "listening";

  // 不 await，后台运行
  dialogLoop(ctx.cfg).catch((err) => {
    console.error("[dialogEngine] dialogLoop unexpected exit:", err?.message);
    dialogState = "idle";
  });

  return { status: "succeeded", outputDigest: { started: true, state: "listening" } };
}

async function execDialogStop(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  dialogState = "idle";
  idleCounter = 0;
  pendingResponse = null;
  return { status: "succeeded", outputDigest: { stopped: true } };
}

async function execDialogStatus(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const audioAvailable = !!findPluginForTool("device.audio.capture");
  return {
    status: "succeeded",
    outputDigest: { state: dialogState, idleCounter, vadThreshold, idleTimeoutMs, responseTimeoutMs, audioAvailable },
  };
}

async function execDialogSay(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const text = typeof ctx.input.text === "string" ? ctx.input.text.trim() : "";
  if (!text) {
    return { status: "failed", errorCategory: "invalid_input", outputDigest: { reason: "missing text" } };
  }
  try {
    await playTtsAudio(ctx.cfg, text);
    return { status: "succeeded", outputDigest: { spoken: true } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "tts_failed", message: err?.message?.slice(0, 300) } };
  }
}

// ── 路由表 ───────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.dialog.start": execDialogStart,
  "device.dialog.stop": execDialogStop,
  "device.dialog.status": execDialogStatus,
  "device.dialog.say": execDialogSay,
};

// ── 生命周期 ──────────────────────────────────────────────────────

async function init(): Promise<void> {
  const audioAvailable = !!findPluginForTool("device.audio.capture");
  console.warn(`[dialogEngine] init complete, audioAvailable=${audioAvailable}`);
}

async function healthcheck(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
  const audioAvailable = !!findPluginForTool("device.audio.capture");
  return { healthy: true, details: { state: dialogState, audioAvailable } };
}

async function execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const handler = TOOL_HANDLERS[ctx.toolName];
  if (!handler) {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "dialogEngine" } };
  }
  return handler(ctx);
}

async function onMessage(ctx: DeviceMessageContext): Promise<void> {
  if (ctx.topic === "dialog.response" && pendingResponse) {
    const text = typeof ctx.payload?.text === "string" ? ctx.payload.text : "";
    pendingResponse.resolve(text);
    pendingResponse = null;
  }

  if (ctx.topic === "local.output") {
    console.warn(`[dialogEngine] local.output: ${JSON.stringify(ctx.payload).slice(0, 200)}`);
  }
}

async function dispose(): Promise<void> {
  dialogState = "idle";
  pendingResponse = null;
  idleCounter = 0;
  console.warn("[dialogEngine] disposed");
}

// ── 插件导出 ──────────────────────────────────────────────────────

const dialogEnginePlugin: DeviceToolPlugin = {
  name: "dialogEngine",
  version: "1.0.0",
  source: "builtin",
  toolPrefixes: ["device.dialog.*"],
  toolNames: ["device.dialog.start", "device.dialog.stop", "device.dialog.status", "device.dialog.say"],
  capabilities: DIALOG_CAPABILITIES,
  messageTopics: ["dialog.response", "local.output"],
  resourceLimits: { maxMemoryMb: 30, maxCpuPercent: 15 },
  deviceTypeResourceProfiles: {
    iot: { maxMemoryMb: 15, maxCpuPercent: 10 },
    robot: { maxMemoryMb: 15, maxCpuPercent: 10 },
    vehicle: { maxMemoryMb: 15, maxCpuPercent: 10 },
    home: { maxMemoryMb: 15, maxCpuPercent: 10 },
  },
  init,
  healthcheck,
  execute,
  onMessage,
  dispose,
};

export default dialogEnginePlugin;
