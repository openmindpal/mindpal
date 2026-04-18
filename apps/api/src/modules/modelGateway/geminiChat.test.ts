import { describe, expect, it } from "vitest";
import { geminiChatWithSecretRotation } from "./geminiChat";

function okResponse(payload: any) {
  return { ok: true, status: 200, json: async () => payload } as any;
}

describe("geminiChatWithSecretRotation", () => {
  it("maps image, audio and video parts to inlineData", async () => {
    let requestBody: any = null;
    const fetchFn = (async (_url: string, init: any) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return okResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      });
    }) as any;

    const out = await geminiChatWithSecretRotation({
      fetchFn,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "input_audio", input_audio: { data: "BBBB", format: "wav" } },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,CCCC" } },
          ],
        },
      ],
      apiKeys: ["k1"],
      timeoutMs: 100,
    });

    expect(out.outputText).toBe("ok");
    expect(requestBody.contents[0].parts).toEqual([
      { text: "describe" },
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
      { inlineData: { mimeType: "audio/wav", data: "BBBB" } },
      { inlineData: { mimeType: "video/mp4", data: "CCCC" } },
    ]);
  });

  it("rejects remote binary urls", async () => {
    await expect(
      geminiChatWithSecretRotation({
        fetchFn: (async () => okResponse({ candidates: [] })) as any,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-2.0-flash",
        messages: [
          {
            role: "user",
            content: [{ type: "video_url", video_url: { url: "https://example.com/demo.mp4" } }],
          },
        ],
        apiKeys: ["k1"],
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ errorCode: "BAD_REQUEST" });
  });
});
