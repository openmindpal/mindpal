/**
 * Dialog Engine Plugin — 对话编排引擎
 *
 * 实现语音对话闭环：VAD → STT → Agent Loop → TTS
 * 状态机：idle → listening → detecting → transcribing → thinking → speaking → listening
 *
 * 对话消息通过 WebSocket device_query 通道发送，自动集成长期记忆、知识RAG、会话持久化。
 * 视频帧缓存为 latestFrame，在发送对话消息时作为多模态附件附带。
 * STT 通过 WebSocket 流式处理（/v1/audio/stream-stt），TTS 通过设备 WebSocket 流式管道处理。
 *
 * @layer plugin
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

import { WebSocket } from "ws";

import type {
  DeviceToolPlugin,
  ToolExecutionContext,
  ToolExecutionResult,
  DeviceMessageContext,
} from "@mindpal/device-agent-sdk";
import type { CapabilityDescriptor } from "@mindpal/device-agent-sdk";
import { findPluginForTool, getMultimodalCapabilities, getActiveWebSocketAgent } from "@mindpal/device-agent-sdk";
import type { DeviceAttachment, DeviceTtsRequest, DeviceTtsAudio } from "@mindpal/shared";

// ── 类型定义 ──────────────────────────────────────────────────────

type DialogState = "idle" | "listening" | "detecting" | "transcribing" | "thinking" | "speaking";

// ── 内部状态 ──────────────────────────────────────────────────────

let dialogState: DialogState = "idle";
let idleCounter = 0;
let vadThreshold = Number(process.env.DEVICE_AGENT_VAD_THRESHOLD) || 500;
let idleTimeoutMs = Number(process.env.DEVICE_AGENT_DIALOG_IDLE_TIMEOUT_MS) || 60000;
let responseTimeoutMs = 15000;

let videoFrameTimer: ReturnType<typeof setInterval> | null = null;

/** 会话级 conversationId — 对话启动时生成，idle 超时后清除 */
let conversationId: string | null = null;

/** 最新视频帧缓存 — 由定时器更新，发送对话消息时附带 */
let latestFrame: { base64: string; format: string } | null = null;

// ── TTS WebSocket 流式状态 ────────────────────────────────────────
let ttsSeqCounter = 0;
const pendingTts = new Map<number, (audio: { audioBase64: string; format: string }) => void>();

// ── VAD 实现（零依赖，纯计算） ────────────────────────────────────

function calcRms(pcm: Buffer): number {
  let sumSquares = 0;
  const sampleCount = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
}

/** VAD feed() 返回值类型 */
interface VadResult {
  event: "speech_start" | "speech_continue" | "speech_end" | "silence";
  confidence: number;
}

/** 自适应 VAD —— EMA平滑 + 环境自适应阈值 + 静默追踪 + 置信度评分，零外部依赖 */
class AdaptiveVad {
  private emaEnergy = 0;
  private ambientEnergy = 0;
  private speechStartedAt = 0;
  private silenceSince = 0;
  private readonly smoothingFactor: number;
  private readonly silenceThresholdMs: number;
  private adaptiveRatio = 2.5;

  // 环境噪声基线
  private noiseFloor = 0;
  private readonly noiseCalibrationMs: number;
  private calibrationSamples: number[] = [];
  private calibrated = false;

  // 动态灵敏度
  private readonly sensitivityProfile: "quiet" | "normal" | "noisy" | "auto";

  // 语音段追踪
  private speechSegmentStart = 0;
  private readonly minSpeechDurationMs: number;

  constructor(cfg?: {
    silenceThresholdMs?: number;
    smoothingFactor?: number;
    noiseCalibrationMs?: number;
    minSpeechDurationMs?: number;
    sensitivityProfile?: "quiet" | "normal" | "noisy" | "auto";
  }) {
    this.smoothingFactor = cfg?.smoothingFactor ?? 0.3;
    this.silenceThresholdMs = cfg?.silenceThresholdMs ?? 600;
    this.noiseCalibrationMs = cfg?.noiseCalibrationMs ?? 3000;
    this.minSpeechDurationMs = cfg?.minSpeechDurationMs ?? 200;
    this.sensitivityProfile = cfg?.sensitivityProfile ?? "auto";
  }

  reset(): void {
    this.emaEnergy = 0;
    this.ambientEnergy = 0;
    this.speechStartedAt = 0;
    this.silenceSince = 0;
    this.speechSegmentStart = 0;
    // 保留校准结果，无需重新校准
  }

  /** 根据灵敏度档位和噪声基线计算自适应比率 */
  private computeAdaptiveRatio(): number {
    if (this.sensitivityProfile !== "auto") {
      switch (this.sensitivityProfile) {
        case "quiet": return 2.0;
        case "normal": return 2.5;
        case "noisy": return 3.5;
      }
    }
    // auto模式：根据noiseFloor动态计算
    if (this.noiseFloor < 500) return 2.0;      // 安静环境
    if (this.noiseFloor < 2000) return 2.5;     // 普通环境
    return 3.5;                                  // 嘈杂环境
  }

  feed(pcm: Buffer, now: number): VadResult {
    const rms = calcRms(pcm);

    // ── 校准阶段：收集环境噪声样本 ──
    if (!this.calibrated) {
      this.calibrationSamples.push(rms);
      // 假设每次 feed 间隔约 200ms（与 stream_read chunkMs 对齐）
      const elapsedMs = this.calibrationSamples.length * 200;
      if (elapsedMs >= this.noiseCalibrationMs) {
        this.noiseFloor = this.calibrationSamples.reduce((a, b) => a + b, 0) / this.calibrationSamples.length;
        this.calibrated = true;
        this.calibrationSamples = []; // 释放内存
        this.adaptiveRatio = this.computeAdaptiveRatio();
        // 以 noiseFloor 初始化 ambientEnergy
        this.ambientEnergy = this.noiseFloor;
      }
      return { event: "silence", confidence: 0 };
    }

    // ── 核心 EMA 平滑（保持不变） ──
    this.emaEnergy = this.smoothingFactor * rms + (1 - this.smoothingFactor) * this.emaEnergy;

    if (!this.speechStartedAt) {
      this.ambientEnergy = 0.05 * rms + 0.95 * this.ambientEnergy;
    }

    const threshold = Math.max(this.ambientEnergy * this.adaptiveRatio, 300);
    const isSpeech = this.emaEnergy > threshold;
    const confidence = threshold > 0 ? Math.min(1, Math.max(0, (rms - threshold) / threshold)) : 0;

    let event: VadResult["event"];

    if (isSpeech) {
      this.silenceSince = 0;
      if (!this.speechStartedAt) {
        this.speechStartedAt = now;
        this.speechSegmentStart = now;
        event = "speech_start";
      } else {
        event = "speech_continue";
      }
      return { event, confidence };
    }

    if (this.speechStartedAt) {
      if (!this.silenceSince) this.silenceSince = now;
      if (now - this.silenceSince >= this.silenceThresholdMs) {
        // 语音段时长检查
        const speechDuration = now - this.speechSegmentStart;
        this.speechStartedAt = 0;
        this.silenceSince = 0;
        this.speechSegmentStart = 0;
        if (speechDuration < this.minSpeechDurationMs) {
          // 短于最小时长，视为噪声脉冲
          return { event: "silence", confidence: 0 };
        }
        return { event: "speech_end", confidence };
      }
      return { event: "speech_continue", confidence };
    }
    return { event: "silence", confidence: 0 };
  }
}

// ── 句子提取工具 ──────────────────────────────────────────────────

function extractSentences(buf: string): { sentences: string[]; remainder: string } {
  const re = /[^。！？!?\n]+[。！？!?\n]+/g;
  const sentences: string[] = [];
  let last = 0;
  for (const m of buf.matchAll(re)) {
    sentences.push(m[0].trim());
    last = (m.index ?? 0) + m[0].length;
  }
  return { sentences, remainder: buf.slice(last) };
}

// ── 流式管道类型 ──────────────────────────────────────────────────

interface StreamingPipeline {
  abort: AbortController;
  done: Promise<void>;
  fullText: () => string;
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

// ── HTTP 降级辅助（仅在 WebSocket 不可用时使用）────────────────────

/** HTTP 降级 STT — POST /v1/audio/transcribe */
async function requestSttHttp(
  cfg: { apiBase: string; deviceToken: string },
  audioBase64: string,
): Promise<string | null> {
  try {
    const resp = await httpRequest(`${cfg.apiBase}/v1/audio/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.deviceToken}`,
      },
      body: JSON.stringify({ audioBase64, format: "wav", sampleRate: 16000 }),
    });
    if (resp.statusCode !== 200) return null;
    const data = JSON.parse(resp.body);
    return typeof data.transcript === "string" && data.transcript.trim() ? data.transcript.trim() : null;
  } catch (err: any) {
    console.error("[dialogEngine] STT HTTP fallback failed:", err?.message);
    return null;
  }
}

/** HTTP 降级 TTS — POST /v1/audio/speech */
async function requestTtsHttp(
  cfg: { apiBase: string; deviceToken: string },
  text: string,
): Promise<string | null> {
  try {
    const resp = await httpRequest(`${cfg.apiBase}/v1/audio/speech`, {
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
    console.error("[dialogEngine] TTS HTTP fallback failed:", err?.message);
    return null;
  }
}

// ── WebSocket device_query 消息发送 ──────────────────────────────

async function sendMessageToCloud(
  cfg: { apiBase: string; deviceToken: string },
  text: string,
): Promise<StreamingPipeline | null> {
  const wsAgent = getActiveWebSocketAgent();
  if (wsAgent) {
    const attachments: DeviceAttachment[] = [];
    if (latestFrame) {
      attachments.push({
        type: "image",
        mimeType: `image/${latestFrame.format}`,
        dataUrl: `data:image/${latestFrame.format};base64,${latestFrame.base64}`,
      });
      latestFrame = null;
    }

    // 流式管道状态
    const sentenceQueue: string[] = [];
    const abortCtrl = new AbortController();
    let streamBuffer = "";
    let fullAccum = "";
    let streamDone = false;

    // 简单的 Promise 通知机制：生产者 resolve → 消费者被唤醒
    let notifyResolve: (() => void) | null = null;
    function notify(): void {
      if (notifyResolve) {
        const r = notifyResolve;
        notifyResolve = null;
        r();
      }
    }
    function waitForSentence(): Promise<void> {
      if (sentenceQueue.length > 0 || streamDone || abortCtrl.signal.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        notifyResolve = resolve;
        // 超时保护，避免永久挂起
        const timer = setTimeout(() => { notifyResolve = null; resolve(); }, 10000);
        const orig = notifyResolve;
        notifyResolve = () => { clearTimeout(timer); orig?.(); notifyResolve = null; resolve(); };
      });
    }

    // 在 abort 时也唤醒等待
    abortCtrl.signal.addEventListener("abort", () => notify(), { once: true });

    try {
      await wsAgent.sendMultimodalQuery(
        text,
        attachments.length > 0 ? attachments : undefined,
        {
          onChunk: (chunk: string) => {
            if (abortCtrl.signal.aborted) return;
            fullAccum += chunk;
            streamBuffer += chunk;
            const { sentences, remainder } = extractSentences(streamBuffer);
            streamBuffer = remainder;
            if (sentences.length > 0) {
              sentenceQueue.push(...sentences);
              notify();
            }
          },
          onDone: () => {
            // 将剩余文本推入队列
            if (streamBuffer.trim()) {
              sentenceQueue.push(streamBuffer.trim());
              streamBuffer = "";
            }
            streamDone = true;
            notify();
          },
          onError: (error: string) => {
            console.error("[dialogEngine] device_query error:", error);
            streamDone = true;
            notify();
          },
        },
        conversationId ?? undefined,
      );

      // 启动流式 TTS 消费管道（后台任务）
      const pipelineDone = streamTtsPipeline(cfg, sentenceQueue, abortCtrl.signal, waitForSentence)
        .catch((err: any) => console.error("[dialogEngine] streamTtsPipeline error:", err?.message));

      return {
        abort: abortCtrl,
        done: pipelineDone as Promise<void>,
        fullText: () => fullAccum,
      };
    } catch (err: any) {
      console.error("[dialogEngine] WS sendMultimodalQuery failed, falling back to HTTP:", err?.message);
      abortCtrl.abort();
    }
  }

  // HTTP fallback（WS 不可用时）— 保持同步模式
  try {
    const resp = await httpRequest(`${cfg.apiBase}/device-agent/dialog/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.deviceToken}`,
      },
      body: JSON.stringify({ text, source: "voice", conversationId }),
    });
    // HTTP fallback 返回完整文本，同步 TTS 播放
    if (resp.statusCode === 200) {
      try {
        const data = JSON.parse(resp.body);
        const replyText = typeof data.reply === "string" ? data.reply : "";
        if (replyText) {
          await playTtsAudio(cfg, replyText);
        }
      } catch { /* 解析失败，静默忽略 */ }
    }
  } catch (err: any) {
    console.error("[dialogEngine] send message failed:", err?.message);
  }
  return null;
}

// ── 流式 TTS 管道 ────────────────────────────────────────────────

/** 通过设备WebSocket发送TTS请求，等待音频响应。失败时返回null触发降级 */
async function requestTtsStreaming(
  text: string,
): Promise<{ audioBase64: string; format: string } | null> {
  const wsAgent = getActiveWebSocketAgent();
  const streamingPolicy = wsAgent?.multimodalPolicy?.streaming;
  if (!streamingPolicy?.ttsStreaming) return null;

  // 获取设备WS的底层发送能力
  const rawWs = (wsAgent as any)?.ws as WebSocket | null;
  if (!rawWs || rawWs.readyState !== WebSocket.OPEN) return null;

  const seqNo = ++ttsSeqCounter;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { pendingTts.delete(seqNo); resolve(null); }, 15000);
    pendingTts.set(seqNo, (audio) => { clearTimeout(timeout); resolve(audio); });
    const req: DeviceTtsRequest = {
      type: "device_tts_request",
      sessionId: conversationId || "default",
      text,
      seqNo,
    };
    rawWs.send(JSON.stringify(req));
  });
}

async function streamTtsPipeline(
  cfg: { apiBase: string; deviceToken: string },
  sentenceQueue: string[],
  signal: AbortSignal,
  waitForSentence: () => Promise<void>,
): Promise<void> {
  const audioPlugin = findPluginForTool("device.audio.play");
  if (!audioPlugin) return;
  while (!signal.aborted) {
    if (sentenceQueue.length === 0) {
      await waitForSentence();
      if (signal.aborted) break;
      continue;
    }
    const sentence = sentenceQueue.shift()!;
    if (!sentence.trim()) continue;
    // 优先尝试WebSocket流式TTS
    let audio: string | null = null;
    const streamResult = await requestTtsStreaming(sentence);
    if (streamResult) {
      audio = streamResult.audioBase64;
    } else {
      // 降级到 HTTP TTS
      audio = await requestTtsHttp(cfg, sentence);
    }
    if (signal.aborted || !audio) break;
    await audioPlugin.execute({
      toolName: "device.audio.play",
      input: { base64: audio, format: "wav" },
      cfg: { apiBase: "", deviceToken: "" },
      execution: { deviceExecutionId: "dialog-tts", toolRef: "device.audio.play" },
      policy: null,
      requireUserPresence: false,
      confirmFn: async () => true,
    } as ToolExecutionContext);
  }
}

// ── TTS 播放 ──────────────────────────────────────────────────────

async function playTtsAudio(
  cfg: { apiBase: string; deviceToken: string },
  text: string,
): Promise<void> {
  // 优先尝试 WebSocket 流式 TTS，降级到 HTTP
  let ttsBase64: string | null = null;
  const streamResult = await requestTtsStreaming(text);
  if (streamResult) {
    ttsBase64 = streamResult.audioBase64;
  } else {
    ttsBase64 = await requestTtsHttp(cfg, text);
  }
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

/** 中止当前活跃的 TTS 流管道并停止播放 */
async function abortActivePipeline(
  pipeline: StreamingPipeline | null,
): Promise<void> {
  if (!pipeline) return;
  pipeline.abort.abort();
  const stopPlugin = findPluginForTool("device.audio.stop");
  if (stopPlugin) {
    try {
      await stopPlugin.execute({
        toolName: "device.audio.stop",
        input: {},
        cfg: { apiBase: "", deviceToken: "" },
        execution: { deviceExecutionId: `audio-stop-${Date.now()}`, toolRef: "device.audio.stop" },
        policy: null,
        requireUserPresence: false,
        confirmFn: async () => true,
      } as ToolExecutionContext);
    } catch { /* 停止失败不中断 */ }
  }
}

// ── 对话循环 ──────────────────────────────────────────────────────

async function dialogLoop(cfg: { apiBase: string; deviceToken: string }): Promise<void> {
  // 从元数据读取 VAD / 视频流配置
  const multimodalCaps = getMultimodalCapabilities();
  const vadCfg = multimodalCaps?.multimodalConfig?.vad;
  const vad = new AdaptiveVad({
    silenceThresholdMs: vadCfg?.silenceThresholdMs ?? 600,
    smoothingFactor: vadCfg?.energySmoothingFactor ?? 0.3,
    noiseCalibrationMs: vadCfg?.noiseCalibrationMs ?? 3000,
    minSpeechDurationMs: vadCfg?.minSpeechDurationMs ?? 200,
    sensitivityProfile: (vadCfg?.sensitivityProfile as "quiet" | "normal" | "noisy" | "auto" | undefined) ?? "auto",
  });

  // 尝试启动音频流式采集
  const streamStartPlugin = findPluginForTool("device.audio.stream_start");
  if (streamStartPlugin) {
    try {
      await streamStartPlugin.execute({
        toolName: "device.audio.stream_start",
        input: { sampleRate: 16000, channels: 1, chunkMs: 200 },
        cfg: { apiBase: cfg.apiBase, deviceToken: cfg.deviceToken },
        execution: { deviceExecutionId: `stream-start-${Date.now()}`, toolRef: "device.audio.stream_start" },
        policy: null,
        requireUserPresence: false,
        confirmFn: async () => true,
      } as ToolExecutionContext);
    } catch (err: any) {
      console.error("[dialogEngine] stream_start failed, falling back to legacy loop:", err?.message);
    }
  }

  // 轻量级视频帧缓存（可选）— 定时采集最新帧到 latestFrame
  const videoStreamCfg = multimodalCaps?.multimodalConfig?.videoStream;
  if (videoStreamCfg?.supported) {
    const intervalMs = videoStreamCfg.frameIntervalMs ?? 1000;
    const cameraPlugin = findPluginForTool("device.camera.capture");
    if (cameraPlugin) {
      videoFrameTimer = setInterval(async () => {
        if (dialogState === "idle") return;
        try {
          const result = await cameraPlugin.execute({
            toolName: "device.camera.capture",
            input: {
              width: videoStreamCfg.maxFrameWidth ?? 640,
              format: videoStreamCfg.format ?? "jpeg",
            },
            cfg: { apiBase: cfg.apiBase, deviceToken: cfg.deviceToken },
            execution: { deviceExecutionId: `video-frame-${Date.now()}`, toolRef: "device.camera.capture" },
            policy: null,
            requireUserPresence: false,
            confirmFn: async () => true,
          } as ToolExecutionContext);
          const digest = result?.outputDigest as Record<string, any> | undefined;
          if (digest?.base64) {
            latestFrame = {
              base64: digest.base64 as string,
              format: videoStreamCfg.format ?? "jpeg",
            };
          }
        } catch {
          /* 帧丢弃，不中断对话 */
        }
      }, intervalMs);
    }
  }

  // 事件驱动主循环：高频 stream_read + AdaptiveVad
  const speechBuffers: Buffer[] = [];
  let activePipeline: StreamingPipeline | null = null;

  // STT 流式 WebSocket 相关状态（元数据驱动）
  const streamingPolicy = getActiveWebSocketAgent()?.multimodalPolicy?.streaming;
  let sttWs: WebSocket | null = null;

  while (dialogState !== "idle") {
    try {
      // 流式路径：读取最新 chunk
      const streamPlugin = findPluginForTool("device.audio.stream_read");
      if (!streamPlugin) { await sleep(200); continue; }
      const readResult = await streamPlugin.execute({
        toolName: "device.audio.stream_read",
        input: { maxChunks: 1, encoding: "base64" },
        cfg: { apiBase: cfg.apiBase, deviceToken: cfg.deviceToken },
        execution: { deviceExecutionId: `stream-read-${Date.now()}`, toolRef: "device.audio.stream_read" },
        policy: null,
        requireUserPresence: false,
        confirmFn: async () => true,
      } as ToolExecutionContext);

      const chunks = (readResult?.outputDigest as Record<string, any>)?.chunks as string[] | undefined;
      if (!chunks?.length) { await sleep(100); continue; }

      const pcm = Buffer.from(chunks[0], "base64");
      const now = Date.now();
      const { event: vadEvent } = vad.feed(pcm, now);

      switch (vadEvent) {
        case "speech_start":
          // 打断：speaking 状态下检测到用户说话，中止 TTS
          if (dialogState === "speaking" && activePipeline) {
            await abortActivePipeline(activePipeline);
            activePipeline = null;
          }
          dialogState = "listening";
          idleCounter = 0;
          speechBuffers.length = 0;
          speechBuffers.push(pcm);
          // 如果元数据开启了流式STT，建立WebSocket连接
          if (streamingPolicy?.sttStreaming) {
            try {
              const wsUrl = cfg.apiBase.replace(/^http/, "ws") + "/v1/audio/stream-stt?language=zh";
              sttWs = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cfg.deviceToken}` } });
              sttWs.on("error", () => { sttWs = null; }); // 降级标记
            } catch { sttWs = null; }
          }
          break;
        case "speech_continue":
          speechBuffers.push(pcm);
          // 流式推送音频帧到STT WebSocket
          if (sttWs?.readyState === WebSocket.OPEN) {
            sttWs.send(JSON.stringify({ type: "audio_chunk", data: pcm.toString("base64") }));
          }
          break;
        case "speech_end": {
          // 打断检测：如果正在播放 TTS，先中止
          if (activePipeline) {
            await abortActivePipeline(activePipeline);
            activePipeline = null;
          }

          dialogState = "transcribing";
          const fullAudio = Buffer.concat(speechBuffers);
          speechBuffers.length = 0;
          const base64Audio = fullAudio.toString("base64");

          let transcript: string | null;
          if (sttWs?.readyState === WebSocket.OPEN) {
            // 流式路径：发送finish并等待final结果
            sttWs.send(JSON.stringify({ type: "finish" }));
            const sttResult = await new Promise<string>((resolve) => {
              const timeout = setTimeout(() => { resolve(""); sttWs?.close(); }, 10000);
              sttWs!.on("message", (raw: Buffer | string) => {
                try {
                  const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
                  if (msg.type === "final") {
                    clearTimeout(timeout);
                    resolve(msg.text || "");
                    sttWs?.close();
                  }
                } catch { /* 解析失败忽略 */ }
              });
            });
            sttWs = null;
            transcript = sttResult.trim() || null;
          } else {
            // 降级路径：原有HTTP POST
            sttWs = null;
            transcript = await requestSttHttp(cfg, base64Audio);
          }
          if (transcript) {
            dialogState = "thinking";
            const pipeline = await sendMessageToCloud(cfg, transcript);
            if (pipeline) {
              // 流式模式：非阻塞 TTS
              dialogState = "speaking";
              activePipeline = pipeline;
              pipeline.done.then(() => {
                if (dialogState === "speaking" && activePipeline === pipeline) {
                  dialogState = "listening";
                  activePipeline = null;
                }
              }).catch(() => {
                if (dialogState === "speaking" && activePipeline === pipeline) {
                  dialogState = "listening";
                  activePipeline = null;
                }
              });
              vad.reset();
              break;
            }
            // HTTP fallback 已在 sendMessageToCloud 内同步播放完成
          }
          dialogState = "listening";
          activePipeline = null;
          vad.reset();
          break;
        }
        case "silence":
          idleCounter += 200; // 每 chunk ≈ 200ms
          if (idleCounter > idleTimeoutMs) {
            dialogState = "idle";
            conversationId = null;
            console.warn("[dialogEngine] idle timeout, stopping dialog loop");
          }
          break;
      }

      await sleep(50);
    } catch (err: any) {
      console.error("[dialogEngine] loop error:", err?.message);
      await sleep(1000);
    }
  }

  // 对话结束：清理音频流和视频帧定时器
  latestFrame = null;
  if (videoFrameTimer) {
    clearInterval(videoFrameTimer);
    videoFrameTimer = null;
  }
  const stopPlugin = findPluginForTool("device.audio.stream_stop");
  if (stopPlugin) {
    try {
      await stopPlugin.execute({
        toolName: "device.audio.stream_stop",
        input: {},
        cfg: { apiBase: cfg.apiBase, deviceToken: cfg.deviceToken },
        execution: { deviceExecutionId: `stream-stop-${Date.now()}`, toolRef: "device.audio.stream_stop" },
        policy: null,
        requireUserPresence: false,
        confirmFn: async () => true,
      } as ToolExecutionContext);
    } catch (err: any) {
      console.error("[dialogEngine] stream_stop failed:", err?.message);
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

  // 生成或复用 conversationId
  if (!conversationId) {
    conversationId = crypto.randomUUID();
  }

  // 不 await，后台运行
  dialogLoop(ctx.cfg).catch((err) => {
    console.error("[dialogEngine] dialogLoop unexpected exit:", err?.message);
    dialogState = "idle";
  });

  return { status: "succeeded", outputDigest: { started: true, state: "listening", conversationId } };
}

async function execDialogStop(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  dialogState = "idle";
  idleCounter = 0;
  latestFrame = null;
  return { status: "succeeded", outputDigest: { stopped: true } };
}

async function execDialogStatus(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const audioAvailable = !!findPluginForTool("device.audio.capture");
  const wsAvailable = !!getActiveWebSocketAgent();
  return {
    status: "succeeded",
    outputDigest: { state: dialogState, idleCounter, vadThreshold, idleTimeoutMs, responseTimeoutMs, audioAvailable, wsAvailable, conversationId },
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
  // TTS WebSocket 流式音频响应
  if (ctx.topic === "device_tts_audio") {
    const msg = ctx.payload as unknown as DeviceTtsAudio;
    if (msg?.seqNo != null) {
      const resolver = pendingTts.get(msg.seqNo);
      if (resolver) {
        resolver({ audioBase64: msg.audioBase64, format: msg.format });
        pendingTts.delete(msg.seqNo);
      }
    }
  }

  if (ctx.topic === "local.output") {
    console.warn(`[dialogEngine] local.output: ${JSON.stringify(ctx.payload).slice(0, 200)}`);
  }
}

async function dispose(): Promise<void> {
  dialogState = "idle";
  idleCounter = 0;
  conversationId = null;
  latestFrame = null;
  if (videoFrameTimer) {
    clearInterval(videoFrameTimer);
    videoFrameTimer = null;
  }
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
  messageTopics: ["device_response", "device_tts_audio", "local.output"],
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
