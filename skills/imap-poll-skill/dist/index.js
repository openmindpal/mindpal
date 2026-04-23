// imap-poll-skill — IMAP 协议轮询未读邮件（编译自 src/index.ts）
"use strict";

const tls = require("node:tls");
const net = require("node:net");
const crypto = require("node:crypto");

// ─── IMAP 客户端 ──────────────────────────────────────────────────────
class ImapClient {
  constructor() {
    this.socket = null;
    this.tagCounter = 0;
    this.buffer = "";
    this.pendingResolve = null;
    this.pendingTag = "";
    this.collectedLines = [];
  }

  async connect(host, port, useTls, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect_timeout")), timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        this._waitForGreeting().then(resolve).catch(reject);
      };
      if (useTls) {
        this.socket = tls.connect({ host, port, rejectUnauthorized: false }, onReady);
      } else {
        this.socket = net.createConnection({ host, port }, onReady);
      }
      this.socket.setEncoding("utf-8");
      this.socket.on("data", (chunk) => this._onData(chunk));
      this.socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  _waitForGreeting() {
    return new Promise((resolve) => {
      if (this.buffer.includes("\r\n")) { this.buffer = ""; resolve(); return; }
      const orig = this.pendingResolve;
      this.pendingResolve = () => { this.pendingResolve = orig; resolve(); };
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      this.collectedLines.push(line);
      if (this.pendingTag && line.startsWith(this.pendingTag + " ")) {
        const resolve = this.pendingResolve;
        const collected = [...this.collectedLines];
        this.collectedLines = [];
        this.pendingResolve = null;
        this.pendingTag = "";
        resolve?.(collected);
      } else if (!this.pendingTag && this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.collectedLines = [];
        this.pendingResolve = null;
        resolve?.([line]);
      }
    }
  }

  _nextTag() { return `A${String(++this.tagCounter).padStart(4, "0")}`; }

  async command(cmd, timeoutMs = 10000) {
    const tag = this._nextTag();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`imap_timeout: ${cmd}`)), timeoutMs);
      this.pendingTag = tag;
      this.pendingResolve = (lines) => {
        clearTimeout(timer);
        const status = lines[lines.length - 1] ?? "";
        if (status.includes("OK")) resolve(lines);
        else reject(new Error(`imap_error: ${status}`));
      };
      this.socket.write(`${tag} ${cmd}\r\n`);
    });
  }

  async login(user, password) {
    const escaped = `"${password.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    await this.command(`LOGIN ${user} ${escaped}`);
  }

  async select(mailbox) {
    const lines = await this.command(`SELECT "${mailbox}"`);
    let exists = 0, uidNext = 0;
    for (const line of lines) {
      const em = line.match(/\*\s+(\d+)\s+EXISTS/i);
      if (em) exists = parseInt(em[1], 10);
      const um = line.match(/UIDNEXT\s+(\d+)/i);
      if (um) uidNext = parseInt(um[1], 10);
    }
    return { exists, uidNext };
  }

  async searchUnseen() {
    const lines = await this.command("UID SEARCH UNSEEN");
    for (const line of lines) {
      if (line.startsWith("* SEARCH")) {
        return line.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => !isNaN(n));
      }
    }
    return [];
  }

  async fetchMessage(uid) {
    const lines = await this.command(
      `UID FETCH ${uid} (INTERNALDATE BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)] BODY[TEXT])`,
      15000,
    );
    const raw = lines.join("\r\n");
    const dateMatch = raw.match(/INTERNALDATE\s+"([^"]+)"/i);
    const internalDate = dateMatch ? dateMatch[1] : new Date().toISOString();
    const blocks = [];
    const re = /\{(\d+)\}/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const start = raw.indexOf("\r\n", m.index) + 2;
      if (start > 1) blocks.push(raw.substring(start, start + parseInt(m[1], 10)));
    }
    return { headers: blocks[0] ?? "", body: (blocks[1] ?? "").trim(), internalDate };
  }

  async logout() { try { await this.command("LOGOUT", 3000); } catch {} }
  destroy() { try { this.socket?.destroy(); } catch {} this.socket = null; }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────
function parseHeaders(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let key = "", val = "";
  for (const line of lines) {
    if (/^\s/.test(line) && key) { val += " " + line.trim(); }
    else {
      if (key) result[key.toLowerCase()] = val;
      const ci = line.indexOf(":");
      if (ci > 0) { key = line.substring(0, ci).trim(); val = line.substring(ci + 1).trim(); }
      else { key = ""; val = ""; }
    }
  }
  if (key) result[key.toLowerCase()] = val;
  return result;
}

function decodeMimeWord(str) {
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, _cs, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf-8");
      return text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    } catch { return str; }
  });
}

function sha256(input) { return crypto.createHash("sha256").update(input).digest("hex"); }

// ─── Mock 模式 ────────────────────────────────────────────────────────
function mockExecute(mailbox, uidNext) {
  const isOversize = mailbox.toUpperCase().includes("OVERSIZE");
  const bodyContent = `mvp imap body uid=${uidNext}\n`;
  const attachmentContent = `mvp imap attachment uid=${uidNext}\n`;
  const oversizeBytes = isOversize ? Buffer.alloc(6 * 1024 * 1024, 0x61) : null;
  const attBytesLen = isOversize ? oversizeBytes.length : Buffer.byteLength(attachmentContent, "utf8");
  const attSha256 = isOversize
    ? crypto.createHash("sha256").update(oversizeBytes).digest("hex")
    : sha256(attachmentContent);
  return {
    uid: uidNext,
    internalDate: new Date().toISOString(),
    summary: { subject: `Test mail ${uidNext}`, from: "", to: "", date: new Date().toISOString() },
    body: {
      contentType: "text/plain; charset=utf-8",
      byteSize: Buffer.byteLength(bodyContent, "utf8"),
      sha256: sha256(bodyContent),
      text: bodyContent,
    },
    bodyContent,
    attachments: [{
      fileName: "attachment.txt",
      contentType: "text/plain; charset=utf-8",
      byteSize: attBytesLen,
      sha256: attSha256,
    }],
    attachmentContent,
    isOversize,
    watermarkAfter: { uidNext: uidNext + 1 },
  };
}

// ─── 主入口 ───────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  const input = req?.input ?? {};
  const mailbox = String(input.mailbox ?? "INBOX");
  const uidNext = Number(input.uidNext ?? 1);
  const host = input.host;
  const port = input.port ?? 993;
  const user = input.user;
  const password = input.password;
  const useTls = input.useTls !== false;
  const maxMessages = input.maxMessages ?? 20;
  const timeoutMs = input.timeoutMs ?? 15000;

  if (!host || !user || !password) {
    return mockExecute(mailbox, uidNext);
  }

  const client = new ImapClient();
  try {
    await client.connect(host, port, useTls, timeoutMs);
    await client.login(user, password);
    const selected = await client.select(mailbox);
    const unseenUids = await client.searchUnseen();
    const targetUids = unseenUids.filter((u) => u >= uidNext).slice(0, maxMessages);

    if (targetUids.length === 0) {
      await client.logout();
      return {
        uid: uidNext,
        internalDate: new Date().toISOString(),
        summary: { subject: "", from: "", to: "", date: "" },
        body: { contentType: "text/plain", byteSize: 0, sha256: sha256(""), text: "" },
        attachments: [],
        watermarkAfter: { uidNext: selected.uidNext },
      };
    }

    const targetUid = targetUids[0];
    const fetched = await client.fetchMessage(targetUid);
    const hdrs = parseHeaders(fetched.headers);
    const subject = decodeMimeWord(hdrs["subject"] ?? "");
    const from = decodeMimeWord(hdrs["from"] ?? "");
    const to = decodeMimeWord(hdrs["to"] ?? "");
    const date = hdrs["date"] ?? fetched.internalDate;
    const bodyBytes = Buffer.byteLength(fetched.body, "utf-8");

    await client.logout();
    return {
      uid: targetUid,
      internalDate: fetched.internalDate,
      summary: { subject, from, to, date },
      body: {
        contentType: "text/plain; charset=utf-8",
        byteSize: bodyBytes,
        sha256: sha256(fetched.body),
        text: fetched.body,
      },
      attachments: [],
      watermarkAfter: { uidNext: Math.max(targetUid + 1, selected.uidNext) },
    };
  } catch (err) {
    throw new Error(`imap_poll_failed: ${err?.message ?? String(err)}`);
  } finally {
    client.destroy();
  }
};
