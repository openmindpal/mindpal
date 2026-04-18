import { describe, expect, it } from "vitest";
import { anthropicChatWithSecretRotation } from "./anthropicChat";

function okResponse(payload: any) {
  return { ok: true, status: 200, json: async () => payload } as any;
}

describe("anthropicChatWithSecretRotation", () => {
  it("converts image data URLs into anthropic image blocks", async () => {
    let requestBody: any = null;
    const fetchFn = (async (_url: string, init: any) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return okResponse({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    }) as any;

    const out = await anthropicChatWithSecretRotation({
      fetchFn,
      baseUrl: "https://api.anthropic.com",
      model: "claude-3-7-sonnet",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
      apiKeys: ["k1"],
      timeoutMs: 100,
    });

    expect(out.outputText).toBe("ok");
    expect(requestBody.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "describe" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AAAA",
          },
        },
      ],
    });
  });

  it("rejects non-data-url image input", async () => {
    await expect(
      anthropicChatWithSecretRotation({
        fetchFn: (async () => okResponse({ content: [] })) as any,
        baseUrl: "https://api.anthropic.com",
        model: "claude-3-7-sonnet",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/demo.png" } }],
          },
        ],
        apiKeys: ["k1"],
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ errorCode: "BAD_REQUEST" });
  });
});
