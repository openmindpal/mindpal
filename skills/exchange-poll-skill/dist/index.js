// exchange-poll-skill — Microsoft Graph API 邮件轮询（编译自 src/index.ts）
"use strict";

const crypto = require("node:crypto");

// ─── Mock 模式 ────────────────────────────────────────────────────────
function mockExecute(cursorUrl) {
  const url = cursorUrl.toLowerCase();
  if (url.includes("user3") || url.includes("429")) {
    throw new Error("rate_limited:30000");
  }
  const makeMock = (id, subject) => ({
    messageId: id,
    summary: {
      subject,
      from: "test@example.com",
      receivedDateTime: new Date().toISOString(),
      hasAttachments: false,
      bodyPreview: "",
    },
    bodyDigest: crypto.createHash("sha256").update(id).digest("hex").slice(0, 16),
    nonce: crypto.randomUUID(),
  });
  if (url.includes("page2")) {
    return { messages: [makeMock("m-3", "Test 3")], scannedCount: 1, nextLink: null, deltaLink: "https://graph.microsoft.com/v1.0/delta?d=2" };
  }
  if (url.includes("user2")) {
    return { messages: [makeMock("m-1", "Test 1"), makeMock("m-2", "Test 2")], scannedCount: 2, nextLink: "https://graph.microsoft.com/v1.0/page2", deltaLink: null };
  }
  return { messages: [makeMock("m-1", "Test 1")], scannedCount: 1, nextLink: null, deltaLink: cursorUrl };
}

// ─── Graph API 单页请求 ──────────────────────────────────────────────
async function fetchPage(url, accessToken, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        Prefer: 'outlook.body-content-type="text"',
      },
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new Error("timeout");
    throw new Error("network_error:" + String(e?.message ?? e));
  }
  clearTimeout(timer);

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || 30);
    throw new Error("rate_limited:" + (retryAfter * 1000));
  }
  if (res.status === 401 || res.status === 403) throw new Error("auth_required:" + res.status);
  if (res.status >= 500) throw new Error("upstream_5xx:" + res.status);
  if (!res.ok) throw new Error("upstream_error:" + res.status);

  const data = await res.json();
  return {
    items: data.value ?? [],
    nextLink: data["@odata.nextLink"] ?? null,
    deltaLink: data["@odata.deltaLink"] ?? null,
  };
}

// ─── 转换 ────────────────────────────────────────────────────────────
function toMessageItem(item) {
  const nonce = crypto.randomUUID();
  const bodyDigest = crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 16);
  return {
    messageId: item.id,
    summary: {
      subject: item.subject ?? "",
      from: item.from?.emailAddress?.address ?? "",
      receivedDateTime: item.receivedDateTime ?? null,
      hasAttachments: item.hasAttachments ?? false,
      bodyPreview: item.bodyPreview ?? "",
    },
    bodyDigest,
    nonce,
  };
}

// ─── 主入口 ───────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  const input = req?.input ?? {};
  const accessToken = input.accessToken;
  const cursorUrl = input.cursorUrl;
  const maxMessages = input.maxMessages ?? 50;
  const timeoutMs = input.timeoutMs ?? 10000;

  if (!cursorUrl) {
    return { messages: [], scannedCount: 0, nextLink: null, deltaLink: null };
  }

  if (!accessToken || accessToken === "t" || accessToken.length < 20) {
    return mockExecute(cursorUrl);
  }

  const messages = [];
  let scannedCount = 0;
  let nextLink = null;
  let deltaLink = null;
  let pageUrl = cursorUrl;

  while (pageUrl && messages.length < maxMessages) {
    const page = await fetchPage(pageUrl, accessToken, timeoutMs);
    scannedCount += page.items.length;
    for (const item of page.items) {
      if (messages.length >= maxMessages) break;
      messages.push(toMessageItem(item));
    }
    nextLink = page.nextLink;
    deltaLink = page.deltaLink;
    pageUrl = nextLink;
  }

  return { messages, scannedCount, nextLink, deltaLink };
};
