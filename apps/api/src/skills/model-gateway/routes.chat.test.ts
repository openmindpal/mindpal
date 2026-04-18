import { describe, expect, it } from "vitest";
import { modelChatBodySchema } from "./routes.chat";

describe("modelChatBodySchema", () => {
  it("accepts plain text messages", () => {
    const parsed = modelChatBodySchema.parse({
      purpose: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(parsed.messages[0]?.content).toBe("hello");
  });

  it("accepts multimodal image messages", () => {
    const parsed = modelChatBodySchema.parse({
      purpose: "vision",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
          ],
        },
      ],
    });

    expect(Array.isArray(parsed.messages[0]?.content)).toBe(true);
  });

  it("accepts audio and video content parts", () => {
    const parsed = modelChatBodySchema.parse({
      purpose: "multimodal",
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,BBBB" } },
          ],
        },
      ],
    });

    expect(Array.isArray(parsed.messages[0]?.content)).toBe(true);
  });
});
