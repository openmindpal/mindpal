import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireSubject } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { transcribeAudio, synthesizeSpeech, getAudioCapabilities } from "../modules/audioService";

export const audioRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /v1/audio/transcribe ─────────────────────────────────
  app.post("/v1/audio/transcribe", async (req) => {
    setAuditContext(req, { resourceType: "audio", action: "transcribe" });
    requireSubject(req);

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
    setAuditContext(req, { resourceType: "audio", action: "speech" });
    requireSubject(req);

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
    setAuditContext(req, { resourceType: "audio", action: "capabilities" });
    requireSubject(req);
    return getAudioCapabilities();
  });
};
