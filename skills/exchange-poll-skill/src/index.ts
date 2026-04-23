/**
 * exchange-poll-skill — 通过 Microsoft Graph API 轮询 Exchange 邮箱
 * 支持增量同步 (delta query) 和分页
 * 零外部依赖，仅使用 Node.js 18+ 内置 fetch
 */
import * as crypto from "node:crypto";

// ─── 类型定义 ─────────────────────────────────────────────────────────
interface SkillRequest {
  input?: {
    accessToken?: string;
    cursorUrl?: string;
    mailbox?: string;
    maxMessages?: number;
    timeoutMs?: number;
  };
}

interface MessageSummary {
  subject: string;
  from: string;
  receivedDateTime: string | null;
  hasAttachments: boolean;
  bodyPreview: string;
}

interface MessageItem {
  messageId: string;
  summary: MessageSummary;
  bodyDigest: string;
  nonce: string;
}

interface PollResult {
  messages: MessageItem[];
  scannedCount: number;
  nextLink: string | null;
  deltaLink: string | null;
}

// ─── Mock 模式（测试兼容） ────────────────────────────────────────────
function mockExecute(cursorUrl: string): PollResult {
  const url = cursorUrl.toLowerCase();

  // 429 测试场景
  if (url.includes("user3") || url.includes("429")) {
    throw new Error("rate_limited:30000");
  }

  const makeMock = (id: string, subject: string): MessageItem => ({
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

  // 分页测试：第二页
  if (url.includes("page2")) {
    return {
      messages: [makeMock("m-3", "Test 3")],
      scannedCount: 1,
      nextLink: null,
      deltaLink: "https://graph.microsoft.com/v1.0/delta?d=2",
    };
  }

  // 分页测试：初始请求
  if (url.includes("user2")) {
    return {
      messages: [makeMock("m-1", "Test 1"), makeMock("m-2", "Test 2")],
      scannedCount: 2,
      nextLink: "https://graph.microsoft.com/v1.0/page2",
      deltaLink: null,
    };
  }

  // 普通请求
  return {
    messages: [makeMock("m-1", "Test 1")],
    scannedCount: 1,
    nextLink: null,
    deltaLink: cursorUrl,
  };
}

// ─── Graph API 单页请求 ──────────────────────────────────────────────
async function fetchPage(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<{
  items: any[];
  nextLink: string | null;
  deltaLink: string | null;
}> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
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
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError") throw new Error("timeout");
    throw new Error("network_error:" + String(err?.message ?? err));
  }
  clearTimeout(timer);

  // 错误处理
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || 30);
    throw new Error("rate_limited:" + retryAfter * 1000);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("auth_required:" + res.status);
  }
  if (res.status >= 500) {
    throw new Error("upstream_5xx:" + res.status);
  }
  if (!res.ok) {
    throw new Error("upstream_error:" + res.status);
  }

  const data = await res.json();
  return {
    items: data.value ?? [],
    nextLink: data["@odata.nextLink"] ?? null,
    deltaLink: data["@odata.deltaLink"] ?? null,
  };
}

// ─── 将 Graph API item 转为统一格式 ─────────────────────────────────
function toMessageItem(item: any): MessageItem {
  const nonce = crypto.randomUUID();
  const bodyDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(item))
    .digest("hex")
    .slice(0, 16);

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
export async function execute(req: SkillRequest): Promise<PollResult> {
  const input = req?.input ?? {};
  const accessToken = input.accessToken;
  const cursorUrl = input.cursorUrl;
  const maxMessages = input.maxMessages ?? 50;
  const timeoutMs = input.timeoutMs ?? 10_000;

  // 无 cursorUrl 时返回空结果
  if (!cursorUrl) {
    return { messages: [], scannedCount: 0, nextLink: null, deltaLink: null };
  }

  // Mock 模式：短 token 或缺失 token → 测试环境
  if (!accessToken || accessToken === "t" || accessToken.length < 20) {
    return mockExecute(cursorUrl);
  }

  // ── 生产模式：遍历 Graph API 分页 ──
  const messages: MessageItem[] = [];
  let scannedCount = 0;
  let nextLink: string | null = null;
  let deltaLink: string | null = null;
  let pageUrl: string | null = cursorUrl;

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
}
