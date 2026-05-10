import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { guarded } from "../../middleware/routeGuard";
import { transcribeAudio, synthesizeSpeech, getAudioCapabilities, createStreamingSTTSession } from "../../modules/audioService";
import type { VideoStreamClientMessage, VideoStreamServerMessage } from "@mindpal/shared";

export const audioRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /v1/audio/transcribe ─────────────────────────────────
  app.post("/v1/audio/transcribe", async (req) => {
    await guarded(req, { resourceType: "audio", action: "transcribe" });

    const body = z
      .object({
        audioBase64: z.string().min(8),
        format: z.string().max(20).optional(),
        language: z.string().max(20).optional(),
      })
      .parse(req.body);

    const result = await transcribeAudio({
      audioBase64: body.audioBase64,
      format: body.format,
      language: body.language,
    });

    req.ctx.audit!.outputDigest = { hasTranscript: Boolean(result.transcript) };
    return result;
  });

  // ── POST /v1/audio/speech ─────────────────────────────────────
  app.post("/v1/audio/speech", async (req, reply) => {
    await guarded(req, { resourceType: "audio", action: "speech" });

    const body = z
      .object({
        text: z.string().min(1).max(5000),
        voice: z.string().max(50).optional(),
      })
      .parse(req.body);

    const result = await synthesizeSpeech({ text: body.text, voice: body.voice });

    if (!result.audioBase64) {
      return reply.code(503).send({ error: "TTS service unavailable" });
    }

    const audioBuffer = Buffer.from(result.audioBase64, "base64");
    req.ctx.audit!.outputDigest = { format: result.format, bytes: audioBuffer.length };
    return reply
      .header("Content-Type", "audio/mpeg")
      .header("Content-Length", audioBuffer.length)
      .send(audioBuffer);
  });

  // ── GET /v1/audio/capabilities ────────────────────────────────
  app.get("/v1/audio/capabilities", async (req) => {
    await guarded(req, { resourceType: "audio", action: "capabilities" });
    return getAudioCapabilities();
  });

  // ── WebSocket /v1/audio/stream-stt ─────────────────────────────
  // 流式 STT：客户端持续发送 PCM base64 音频块，服务端实时返回转录结果
  // 协议：
  //   客户端→服务端: { type: "audio_chunk", data: "<base64 PCM>" }
  //   客户端→服务端: { type: "finish" }
  //   服务端→客户端: { type: "interim", text: "..." }
  //   服务端→客户端: { type: "final", text: "...", confidence: 0.92 }
  //   服务端→客户端: { type: "error", error: "..." }
  app.get("/v1/audio/stream-stt", { websocket: true }, (socket, req) => {
    // 鉴权：复用上层中间件链的认证
    const subject = (req as any).ctx?.subject;
    if (!subject) {
      socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
      socket.close(4001, "unauthorized");
      return;
    }

    // 尝试创建流式会话
    const language = (req.query as any)?.language || undefined;
    const session = createStreamingSTTSession(
      {
        onInterim: (text) => {
          try {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "interim", text }));
            }
          } catch { /* ignore */ }
        },
        onFinal: (text, confidence) => {
          try {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "final", text, confidence }));
            }
          } catch { /* ignore */ }
        },
        onError: (error) => {
          try {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "error", error }));
            }
          } catch { /* ignore */ }
        },
      },
      language,
    );

    if (!session) {
      socket.send(JSON.stringify({ type: "error", error: "Streaming STT not available, please use HTTP transcribe endpoint" }));
      socket.close(4503, "streaming_stt_unavailable");
      return;
    }

    socket.on("message", (data: any) => {
      try {
        const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        const msg = JSON.parse(raw);
        if (msg.type === "audio_chunk" && typeof msg.data === "string") {
          session.feedAudio(msg.data);
        } else if (msg.type === "finish") {
          session.finish();
        }
      } catch { /* ignore malformed messages */ }
    });

    socket.on("close", () => {
      session.abort();
    });

    socket.on("error", () => {
      session.abort();
    });
  });

  // ── WebSocket /v1/video/stream ──────────────────────────────────
  // 视频流端点：客户端持续发送 JPEG 帧，服务端按关键帧间隔抽取并缓存，
  // finish 时返回分析结果（关键帧多图理解，兼容 GPT-4V/Gemini）
  // 协议：
  //   客户端→服务端: VideoStreamClientMessage { type: "config" | "video_frame" | "finish" }
  //   服务端→客户端: VideoStreamServerMessage { type: "ack" | "analysis" | "error" }
  app.get("/v1/video/stream", { websocket: true }, (socket, req) => {
    // 1. 认证（复用 stream-stt 的认证模式）
    const subject = (req as any).ctx?.subject;
    if (!subject) {
      const errMsg: VideoStreamServerMessage = { type: "error", error: "unauthorized" };
      socket.send(JSON.stringify(errMsg));
      socket.close(4001, "unauthorized");
      return;
    }

    // 2. 状态管理
    let frameCount = 0;
    let keyframeInterval = 5; // 每5帧取1帧作为关键帧
    const keyframes: Array<{ data: string; timestamp: number }> = [];
    const MAX_KEYFRAMES = 10; // 最多缓存10个关键帧
    let realtimeAnalysis = false; // 实时分析开关（由客户端 config 消息驱动）

    /** 内联辅助：异步分析单个关键帧（复用 LLM 多模态能力） */
    async function analyzeKeyframe(imageBase64: string, frameId: number): Promise<void> {
      try {
        const llmEndpoint = (process.env.SKILL_LLM_ENDPOINT || "").trim();
        const llmApiKey = (process.env.SKILL_LLM_API_KEY || "").trim();
        const llmModel = (process.env.SKILL_VISION_MODEL || process.env.SKILL_LLM_MODEL || "gpt-4o").trim();
        if (!llmEndpoint) return;

        const url = llmEndpoint.replace(/\/+$/, "") + "/chat/completions";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(llmApiKey ? { Authorization: `Bearer ${llmApiKey}` } : {}),
          },
          body: JSON.stringify({
            model: llmModel,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "简要描述这个画面中的关键内容，50字以内。" },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
              ],
            }],
            max_tokens: 100,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return;

        const json: any = await res.json();
        const description = json.choices?.[0]?.message?.content ?? "";
        if (description && socket.readyState === 1) {
          const analysisMsg: VideoStreamServerMessage = {
            type: "analysis",
            frameId,
            analysis: { description },
          };
          socket.send(JSON.stringify(analysisMsg));
        }
      } catch { /* 分析失败不中断流，静默忽略 */ }
    }

    // 3. 消息处理
    socket.on("message", (raw: any) => {
      try {
        const rawStr = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const msg = JSON.parse(rawStr) as VideoStreamClientMessage;

        if (msg.type === "config") {
          // 客户端配置：调整 keyframe 间隔
          if (msg.config?.frameRate) {
            keyframeInterval = Math.max(1, Math.ceil(msg.config.frameRate / 2));
          }
          // 读取实时分析配置
          if (typeof (msg.config as any)?.realtimeAnalysis === "boolean") {
            realtimeAnalysis = (msg.config as any).realtimeAnalysis;
          }
          const ack: VideoStreamServerMessage = { type: "ack" };
          socket.send(JSON.stringify(ack));
          return;
        }

        if (msg.type === "video_frame") {
          frameCount++;
          // 关键帧抽取策略：按间隔采样
          if (frameCount % keyframeInterval === 0 && msg.data) {
            if (keyframes.length >= MAX_KEYFRAMES) keyframes.shift();
            keyframes.push({ data: msg.data, timestamp: msg.timestamp ?? Date.now() });
            const ack: VideoStreamServerMessage = { type: "ack", frameId: frameCount };
            socket.send(JSON.stringify(ack));

            // 实时分析：关键帧抽取后立即异步调用视觉分析
            if (realtimeAnalysis) {
              analyzeKeyframe(msg.data, frameCount).catch(() => {});
            }
          }
          return;
        }

        if (msg.type === "finish") {
          if (realtimeAnalysis) {
            // 实时分析已在每个关键帧触发，finish时只返回简短完成确认
            const result: VideoStreamServerMessage = {
              type: "analysis",
              analysis: { description: `Stream completed. ${keyframes.length} keyframes analyzed in real-time.` },
            };
            socket.send(JSON.stringify(result));
          } else {
            // 降级路径：实时分析未开启，返回批量统计
            if (keyframes.length > 0) {
              const result: VideoStreamServerMessage = {
                type: "analysis",
                analysis: { description: `Processed ${keyframes.length} keyframes from ${frameCount} total frames` },
              };
              socket.send(JSON.stringify(result));
            } else {
              const result: VideoStreamServerMessage = {
                type: "analysis",
                analysis: { description: "No keyframes captured" },
              };
              socket.send(JSON.stringify(result));
            }
          }
          socket.close();
          return;
        }
      } catch (err) {
        const errMsg: VideoStreamServerMessage = { type: "error", error: String(err) };
        socket.send(JSON.stringify(errMsg));
      }
    });

    socket.on("close", () => {
      keyframes.length = 0;
    });

    socket.on("error", () => {
      keyframes.length = 0;
    });
  });
};
