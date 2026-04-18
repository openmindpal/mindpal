import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.text || typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "Missing text parameter" }, { status: 400 });
  }

  const apiKey = process.env.TTS_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = (process.env.TTS_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.TTS_MODEL || "tts-1";
  const voice = body.voice || process.env.TTS_VOICE || "alloy";

  if (!apiKey) {
    return NextResponse.json({
      error: "TTS is not configured",
      message: "Set TTS_API_KEY or OPENAI_API_KEY in the environment.",
      hint: "After configuration, natural voice responses become available.",
    }, { status: 503 });
  }

  const inputText = body.text.trim().slice(0, 4000);

  try {
    const ttsUrl = `${baseUrl}/audio/speech`;
    const res = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: inputText,
        voice,
        response_format: "mp3",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[TTS] API error ${res.status}:`, errText);
      return NextResponse.json(
        { error: `TTS API returned ${res.status}`, detail: errText },
        { status: 502 },
      );
    }

    const audioData = await res.arrayBuffer();
    return new NextResponse(audioData, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("[TTS] Request failed:", err);
    return NextResponse.json(
      { error: `TTS request failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
