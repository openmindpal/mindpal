/**
 * Local Input Plugin — 本地交互入口插件
 *
 * 提供三种本地输入通道（按优先级探测）：
 *   1. stdin — CLI 交互（TTY 环境）
 *   2. Local HTTP — 127.0.0.1 本地 API
 *   3. Named Pipe / Unix Socket — IPC 通道
 *
 * 所有通道收到的输入通过回调函数通知外部（agent / index）。
 *
 * @layer plugin
 */
import readline from "node:readline";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import type {
  DeviceToolPlugin,
  ToolExecutionContext,
  ToolExecutionResult,
  CapabilityDescriptor,
  DeviceMessageContext,
} from "../kernel/types";

// ── 类型 ──────────────────────────────────────────────────────

interface InputChannelState {
  stdin: { active: boolean };
  http: { active: boolean; port?: number };
  pipe: { active: boolean; path?: string };
}

export type LocalInputCallback = (message: {
  text: string;
  source: string;
  timestamp: number;
}) => void;

// ── 内部状态 ──────────────────────────────────────────────────

let _onInput: LocalInputCallback | null = null;
let _rl: readline.Interface | null = null;
let _httpServer: http.Server | null = null;
let _pipeServer: net.Server | null = null;

const _state: InputChannelState = {
  stdin: { active: false },
  http: { active: false },
  pipe: { active: false },
};

/** 供外部注册输入回调 */
export function setLocalInputCallback(cb: LocalInputCallback): void {
  _onInput = cb;
}

// ── 通道：stdin ───────────────────────────────────────────────

function startStdin(): void {
  if (!process.stdin.isTTY) return;
  try {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "device> " });
    _rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      _onInput?.({ text, source: "stdin", timestamp: Date.now() });
    });
    _rl.on("close", () => { _state.stdin.active = false; });
    _rl.prompt();
    _state.stdin.active = true;
    console.warn("[localInput] stdin 通道已启动");
  } catch (e: any) {
    console.error(`[localInput] stdin 启动失败: ${e?.message}`);
  }
}

// ── 通道：Local HTTP ──────────────────────────────────────────

function startHttp(): Promise<void> {
  return new Promise((resolve) => {
    const port = Number(process.env.DEVICE_AGENT_LOCAL_PORT) || 19230;
    const server = http.createServer((req, res) => {
      // CORS
      res.setHeader("Content-Type", "application/json");

      if (req.method === "GET" && req.url === "/status") {
        res.writeHead(200);
        res.end(JSON.stringify({ channels: _state, activeChannels: getActiveChannels() }));
        return;
      }

      if (req.method === "POST" && req.url === "/input") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const text = typeof parsed.message === "string" ? parsed.message.trim() : "";
            if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: "missing message" })); return; }
            _onInput?.({ text, source: parsed.source ?? "http", timestamp: Date.now() });
            res.writeHead(200);
            res.end(JSON.stringify({ sent: true, timestamp: Date.now() }));
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "invalid json" }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`[localInput] HTTP 端口 ${port} 已占用，跳过`);
      } else {
        console.error(`[localInput] HTTP 启动失败: ${err.message}`);
      }
      resolve();
    });

    server.listen(port, "127.0.0.1", () => {
      _httpServer = server;
      _state.http = { active: true, port };
      console.warn(`[localInput] HTTP 通道已启动: 127.0.0.1:${port}`);
      resolve();
    });
  });
}

// ── 通道：Named Pipe / Unix Socket ───────────────────────────

function getPipePath(): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\device-agent-input"
    : "/tmp/device-agent-input.sock";
}

function startPipe(): Promise<void> {
  return new Promise((resolve) => {
    const pipePath = getPipePath();

    // Linux/macOS: 清理遗留 sock 文件
    if (process.platform !== "win32") {
      try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
    }

    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        // 按换行分割消息
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const text = line.trim();
          if (!text) continue;
          _onInput?.({ text, source: "pipe", timestamp: Date.now() });
        }
      });
    });

    server.on("error", (err: any) => {
      console.warn(`[localInput] Pipe 启动失败: ${err.message}`);
      resolve();
    });

    server.listen(pipePath, () => {
      _pipeServer = server;
      _state.pipe = { active: true, path: pipePath };
      console.warn(`[localInput] Pipe 通道已启动: ${pipePath}`);
      resolve();
    });
  });
}

// ── 工具函数 ──────────────────────────────────────────────────

function getActiveChannels(): string[] {
  const list: string[] = [];
  if (_state.stdin.active) list.push("stdin");
  if (_state.http.active) list.push("http");
  if (_state.pipe.active) list.push("pipe");
  return list;
}

// ── 能力声明 ──────────────────────────────────────────────────

const LOCAL_INPUT_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.input.send", riskLevel: "low", description: "向云端发送本地消息" },
  { toolRef: "device.input.status", riskLevel: "low", description: "查看本地输入通道状态" },
];

// ── 生命周期 ──────────────────────────────────────────────────

async function init(): Promise<void> {
  startStdin();
  await Promise.all([startHttp(), startPipe()]);
  const active = getActiveChannels();
  console.warn(`[localInput] 初始化完成，活跃通道: ${active.length ? active.join(", ") : "无"}`);
}

async function healthcheck(): Promise<{ healthy: boolean; details?: Record<string, unknown> }> {
  const active = getActiveChannels();
  return { healthy: active.length > 0, details: { channels: { ..._state }, activeChannels: active } };
}

async function execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const { toolName, input } = ctx;

  if (toolName === "device.input.send") {
    const text = typeof input.message === "string" ? input.message.trim() : "";
    if (!text) {
      return { status: "failed", errorCategory: "invalid_input", outputDigest: { error: "missing message" } };
    }
    const msg = { text, source: (input.source as string) ?? "api", timestamp: Date.now() };
    _onInput?.(msg);
    return { status: "succeeded", outputDigest: { sent: true, timestamp: msg.timestamp } };
  }

  if (toolName === "device.input.status") {
    return { status: "succeeded", outputDigest: { channels: { ..._state }, activeChannels: getActiveChannels() } };
  }

  return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName } };
}

async function onMessage(ctx: DeviceMessageContext): Promise<void> {
  if (ctx.topic === "local.output") {
    const text = typeof ctx.payload.text === "string" ? ctx.payload.text : JSON.stringify(ctx.payload);
    if (_state.stdin.active) {
      process.stdout.write(`\n[output] ${text}\n`);
      _rl?.prompt();
    }
    console.warn(`[localInput] local.output: ${text.slice(0, 200)}`);
  }
}

async function dispose(): Promise<void> {
  if (_rl) { _rl.close(); _rl = null; _state.stdin.active = false; }
  if (_httpServer) { await new Promise<void>((r) => _httpServer!.close(() => r())); _httpServer = null; _state.http = { active: false }; }
  if (_pipeServer) {
    const pipePath = _state.pipe.path;
    await new Promise<void>((r) => _pipeServer!.close(() => r()));
    _pipeServer = null;
    _state.pipe = { active: false };
    // 清理 Unix Socket 文件
    if (pipePath && process.platform !== "win32") {
      try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
    }
  }
  console.warn("[localInput] 已销毁");
}

// ── 插件导出 ──────────────────────────────────────────────────

const localInputPlugin: DeviceToolPlugin = {
  name: "localInput",
  version: "1.0.0",
  source: "builtin",
  toolPrefixes: ["device.input.*"],
  toolNames: ["device.input.send", "device.input.status"],
  capabilities: LOCAL_INPUT_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 10, maxCpuPercent: 5 },
  messageTopics: ["local.input", "local.output"],
  init,
  healthcheck,
  execute,
  onMessage,
  dispose,
};

export default localInputPlugin;
