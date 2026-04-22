// ─── bridge-send-skill v2 ── 统一消息发送（Bridge / Webhook / Slack）────
// 根据 provider 参数路由到不同的发送逻辑:
//   bridge  → Bridge 协议（QQ OneBot / iMessage Bridge 等 IM 平台）
//   webhook → 通用 Webhook HTTP POST
//   slack   → Slack Web API chat.postMessage
//
// 合并自原 webhook-send-skill 和 slack-send-skill，统一入口、统一追踪。

"use strict";

// ─── Bridge 模式 ────────────────────────────────────────────────────
async function sendViaBridge(input) {
  const { baseUrl, secret, provider, workspaceId, requestId, traceId, to, message, idempotencyKey } = input;
  if (!baseUrl || !secret) throw new Error("bridge mode requires baseUrl and secret");

  const url = `${baseUrl.replace(/\/+$/, "")}/api/send`;
  const headers = {
    "content-type": "application/json",
    "x-secret": secret,
  };
  if (traceId) headers["x-trace-id"] = traceId;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const body = JSON.stringify({
    provider,
    workspaceId,
    requestId,
    to,
    message,
  });

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`bridge send failed: ${res.status} ${text}`);
  }
  return { ok: true };
}

// ─── Webhook 模式 ───────────────────────────────────────────────────
async function sendViaWebhook(input) {
  const { webhookUrl, text } = input;
  if (!webhookUrl) throw new Error("webhook mode requires webhookUrl");
  if (!text) throw new Error("webhook mode requires text");

  const headers = { "content-type": "application/json" };
  if (input.traceId) headers["x-trace-id"] = input.traceId;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });

  return { ok: res.ok, status: res.status };
}

// ─── Slack 模式 ─────────────────────────────────────────────────────
async function sendViaSlack(input) {
  const { botToken, channel, text } = input;
  if (!botToken) throw new Error("slack mode requires botToken");
  if (!channel) throw new Error("slack mode requires channel");
  if (!text) throw new Error("slack mode requires text");

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${botToken}`,
  };
  if (input.traceId) headers["x-trace-id"] = input.traceId;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, text }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`slack send failed: ${res.status} ${errText}`);
  }

  const data = await res.json().catch(() => ({}));
  return { ok: Boolean(data.ok) };
}

// ─── 主入口 ─────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  const input = req?.input ?? {};
  const provider = String(input.provider ?? "bridge").toLowerCase();

  switch (provider) {
    case "webhook":
      return sendViaWebhook(input);
    case "slack":
      return sendViaSlack(input);
    case "bridge":
    default:
      return sendViaBridge(input);
  }
};
