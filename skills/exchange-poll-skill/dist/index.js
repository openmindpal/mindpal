// Exchange Poll skill - polls Exchange mailbox via Graph API delta
const crypto = require("crypto");

exports.execute = async function execute(req) {
  const input = req?.input ?? {};
  const accessToken = input.accessToken;
  const cursorUrl = input.cursorUrl;
  const maxMessages = input.maxMessages ?? 50;
  const timeoutMs = input.timeoutMs ?? 10_000;

  if (!cursorUrl) {
    return { messages: [], scannedCount: 0, nextLink: null, deltaLink: null };
  }

  const messages = [];
  let scannedCount = 0;
  let nextLink = null;
  let deltaLink = null;
  let url = cursorUrl;

  while (url && messages.length < maxMessages) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(t);
      if (e?.name === "AbortError") throw new Error("timeout");
      throw new Error("network_error:" + String(e?.message ?? e));
    }
    clearTimeout(t);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || 30);
      throw new Error("rate_limited:" + (retryAfter * 1000));
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
    const items = data.value ?? [];
    scannedCount += items.length;

    for (const item of items) {
      if (messages.length >= maxMessages) break;
      const nonce = crypto.randomUUID();
      const bodyDigest = crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 16);
      messages.push({
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
      });
    }

    nextLink = data["@odata.nextLink"] ?? null;
    deltaLink = data["@odata.deltaLink"] ?? null;
    url = nextLink;
  }

  return { messages, scannedCount, nextLink, deltaLink };
};
