import { NextRequest, NextResponse } from "next/server";

function getSTTConfig() {
  const apiKey = (process.env.STT_API_KEY || process.env.TTS_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const baseUrl = (process.env.STT_BASE_URL || process.env.TTS_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = (process.env.STT_MODEL || "whisper-1").trim();
  return { apiKey, baseUrl, model };
}

function getTTSConfig() {
  const apiKey = (process.env.TTS_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const baseUrl = (process.env.TTS_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = (process.env.TTS_MODEL || "tts-1").trim();
  const voice = (process.env.TTS_VOICE || "alloy").trim();
  return { apiKey, baseUrl, model, voice };
}

export async function GET() {
  const stt = getSTTConfig();
  const tts = getTTSConfig();
  const sttReady = Boolean(stt.apiKey);
  const ttsReady = Boolean(tts.apiKey);
  const status = sttReady && ttsReady ? "ready" : sttReady || ttsReady ? "partial" : "not_configured";

  return NextResponse.json({
    status,
    stt: {
      ready: sttReady,
      model: sttReady ? stt.model : null,
      hint: sttReady ? undefined : "Set STT_API_KEY (or OPENAI_API_KEY) + STT_BASE_URL to enable server-side speech recognition.",
    },
    tts: {
      ready: ttsReady,
      model: ttsReady ? tts.model : null,
      voice: ttsReady ? tts.voice : null,
      hint: ttsReady ? undefined : "Set TTS_API_KEY (or OPENAI_API_KEY) + TTS_BASE_URL to enable text-to-speech.",
    },
    capabilities: [
      ...(sttReady ? ["server_stt"] : []),
      ...(ttsReady ? ["tts"] : []),
      "browser_stt",
    ],
  });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const audioBase64: string = body.audio ?? body.audioBase64 ?? "";
    const language: string = body.language ?? "";
    if (!audioBase64) {
      return NextResponse.json({ error: "Missing audio data (audio or audioBase64 field)" }, { status: 400 });
    }

    const cfg = getSTTConfig();
    if (!cfg.apiKey) {
      return NextResponse.json({
        error: "STT is not configured",
        message: "Set STT_API_KEY (or OPENAI_API_KEY) in the environment to enable server-side speech recognition.",
      }, { status: 503 });
    }

    return await transcribeBase64(cfg, audioBase64, language, body.format);
  }

  if (contentType.includes("multipart/form-data")) {
    const cfg = getSTTConfig();
    if (!cfg.apiKey) {
      return NextResponse.json({
        error: "STT is not configured",
        message: "Set STT_API_KEY (or OPENAI_API_KEY) in the environment.",
      }, { status: 503 });
    }

    try {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const language = (formData.get("language") as string) ?? "";
      if (!file) {
        return NextResponse.json({ error: "Missing file in form data" }, { status: 400 });
      }

      const whisperForm = new FormData();
      whisperForm.append("file", file, file.name || "audio.webm");
      whisperForm.append("model", cfg.model);
      whisperForm.append("response_format", "json");
      if (language) whisperForm.append("language", language);

      const whisperUrl = `${cfg.baseUrl}/audio/transcriptions`;
      const res = await fetch(whisperUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: whisperForm,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error(`[Voice/STT] Whisper API error ${res.status}:`, errText);
        return NextResponse.json(
          { error: `STT API returned ${res.status}`, detail: errText },
          { status: 502 },
        );
      }

      const data = await res.json();
      return NextResponse.json({
        transcript: data.text ?? "",
        language: data.language ?? language ?? "",
        durationMs: typeof data.duration === "number" ? Math.round(data.duration * 1000) : null,
        confidence: 0.9,
      });
    } catch (err) {
      console.error("[Voice/STT] Request failed:", err);
      return NextResponse.json(
        { error: `STT request failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ error: "Unsupported content type. Use application/json or multipart/form-data." }, { status: 415 });
}

async function transcribeBase64(
  cfg: { apiKey: string; baseUrl: string; model: string },
  audioBase64: string,
  language: string,
  format?: string,
) {
  try {
    const binaryStr = atob(audioBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const ext = format || "webm";
    const mimeType = ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : "audio/webm";
    const blob = new Blob([bytes], { type: mimeType });

    const formData = new FormData();
    formData.append("file", blob, `audio.${ext}`);
    formData.append("model", cfg.model);
    formData.append("response_format", "json");
    if (language) formData.append("language", language);

    const whisperUrl = `${cfg.baseUrl}/audio/transcriptions`;
    const res = await fetch(whisperUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[Voice/STT] Whisper base64 error ${res.status}:`, errText);
      return NextResponse.json(
        { error: `STT API returned ${res.status}`, detail: errText },
        { status: 502 },
      );
    }

    const data = await res.json();
    return NextResponse.json({
      transcript: data.text ?? "",
      language: data.language ?? language ?? "",
      durationMs: typeof data.duration === "number" ? Math.round(data.duration * 1000) : null,
      confidence: 0.9,
    });
  } catch (err) {
    console.error("[Voice/STT] base64 transcribe failed:", err);
    return NextResponse.json(
      { error: `STT request failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
