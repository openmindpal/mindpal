import { describe, expect, it } from "vitest";
import { toSessionContextListItem } from "./sessionContextRepo";

describe("toSessionContextListItem", () => {
  it("uses totalTurnCount and summary when the retained window is trimmed", () => {
    const item = toSessionContextListItem({
      sessionId: "conv_1",
      context: {
        v: 1,
        messages: [
          { role: "assistant", content: "latest reply" },
          { role: "user", content: "latest user question" },
        ],
        summary: "用户最早讨论的是首页历史弹窗数据异常，后来继续追查消息总数偏差。",
        totalTurnCount: 42,
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      expiresAt: null,
    });

    expect(item.messageCount).toBe(42);
    expect(item.retainedMessageCount).toBe(2);
    expect(item.isTrimmed).toBe(true);
    expect(item.preview).toBe("用户最早讨论的是首页历史弹窗数据异常，后来继续追查消息总数偏差。");
  });

  it("prefers the first user message when the session is not trimmed", () => {
    const item = toSessionContextListItem({
      sessionId: "conv_2",
      context: {
        v: 1,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "   第一条用户消息\n\n带换行   " },
          { role: "assistant", content: "assistant reply" },
          { role: "user", content: "第二条用户消息" },
        ],
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      expiresAt: null,
    });

    expect(item.messageCount).toBe(4);
    expect(item.retainedMessageCount).toBe(4);
    expect(item.isTrimmed).toBe(false);
    expect(item.preview).toBe("第一条用户消息 带换行");
  });
});
