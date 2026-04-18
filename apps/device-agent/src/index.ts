#!/usr/bin/env node
import os from "node:os";
import { parseCli, getStringOpt } from "./cli";
import { defaultConfigPath, loadConfigFile, saveConfigFile, killExistingInstance, acquireLock, releaseLock } from "./config";
import { apiPostJson } from "./api";
import { runLoop } from "./agent";
import { createWebSocketDeviceAgent } from "./websocketClient";
import { confirmPrompt } from "./prompt";
import { safeError, safeLog, sha256_8 } from "./log";
import { listPlugins } from "./kernel/capabilityRegistry";
import { loadPluginsFromDir } from "./pluginRegistry";
import { startTray } from "./tray";
import { initAudit, cleanupOldAuditLogs } from "./kernel/audit";
import { initPlugin } from "./kernel/pluginLifecycle";
import { initSessionManager, shutdownSessionManager } from "./kernel/session";
import { initPolicyCache } from "./kernel/auth";
import { assertKernelManifest, assertPluginBoundary } from "./kernel";

function resolveApiBase(opts: Record<string, string | boolean>) {
  return getStringOpt(opts, "apiBase") || process.env.API_BASE || "http://localhost:3001";
}

/**
 * 共享的设备运行时初始化逻辑（审计、访问控制、任务队列、会话管理、策略缓存）。
 * cmdRun 和 cmdTray 共用，消除重复初始化代码。
 */
async function initDeviceRuntime(cfg: { deviceId: string; deviceToken: string; apiBase?: string; os?: string; agentVersion?: string }, apiBase: string) {
  assertKernelManifest();
  assertPluginBoundary();

  // 初始化审计日志
  initAudit({ deviceId: cfg.deviceId, enabled: process.env.AUDIT_ENABLED !== "false" });
  cleanupOldAuditLogs(30).catch(() => {});

  // 访问控制与任务队列：按需加载（轻量模式可跳过）
  if (process.env.DEVICE_AGENT_LIGHTWEIGHT !== "true") {
    const { initAccessControl, cleanupExpiredContexts } = await import("./kernel/auth");
    initAccessControl({
      secretKey: process.env.DEVICE_AGENT_SECRET_KEY,
      policy: { maxContextAge: 3600_000 },
    });
    cleanupExpiredContexts();

    const { initTaskQueue } = await import("./kernel/taskExecutor");
    initTaskQueue({ maxQueueSize: 100, defaultPriority: "normal", defaultTimeoutMs: 60_000, maxRetries: 3 });
  }

  // 初始化会话管理器（含心跳）
  initSessionManager({
    apiBase,
    deviceToken: cfg.deviceToken,
    deviceId: cfg.deviceId,
    intervalMs: 60_000,
    enabled: process.env.SESSION_HEARTBEAT_ENABLED !== "false",
    os: cfg.os,
    agentVersion: cfg.agentVersion,
  }, async (body) => {
    const { apiPostJson } = await import("./api");
    return apiPostJson({ apiBase, path: "/device-agent/heartbeat", token: cfg.deviceToken, body });
  });

  // 初始化策略缓存
  await initPolicyCache({
    deviceId: cfg.deviceId,
    maxAgeMs: 24 * 60 * 60 * 1000,
    enabled: process.env.POLICY_CACHE_ENABLED !== "false",
  });
}

function agentVersion() {
  return process.env.AGENT_VERSION || "1.0.0";
}

function detectOs() {
  return process.env.AGENT_OS || `${os.platform()}-${os.release()}`;
}

function detectDeviceType(opts: Record<string, string | boolean>) {
  const v = getStringOpt(opts, "deviceType");
  return v === "mobile" ? "mobile" : "desktop";
}

async function cmdPair(opts: Record<string, string | boolean>) {
  const pairingCode = getStringOpt(opts, "pairingCode");
  if (!pairingCode) throw new Error("missing_pairingCode");
  const apiBase = resolveApiBase(opts);
  const deviceType = detectDeviceType(opts);
  const osName = detectOs();
  const v = agentVersion();
  const cfgPath = getStringOpt(opts, "config") || defaultConfigPath();

  // 收集已加载插件的能力列表，配对时上报给云端
  const plugins = listPlugins();
  const capabilities = plugins.flatMap((p) =>
    (p.toolNames ?? []).filter((n: string) => n.startsWith("device.")).map((toolRef: string) => ({
      toolRef,
      pluginName: p.name,
      version: p.version ?? "1.0.0",
    }))
  );
  const pluginNames = plugins.map((p) => p.name);

  const r = await apiPostJson<{ deviceId: string; deviceToken: string }>({
    apiBase,
    path: "/device-agent/pair",
    body: {
      pairingCode,
      deviceType,
      os: osName,
      agentVersion: v,
      capabilities,   // 新增：端侧能力上报
      pluginNames,    // 新增：已加载插件名列表
    },
  });
  if (r.status !== 200) throw new Error(`pair_failed_${r.status}`);
  const deviceId = String((r.json as any).deviceId);
  const deviceToken = String((r.json as any).deviceToken);
  if (!deviceId || !deviceToken) throw new Error("pair_invalid_response");

  // 配对成功后，检查云端是否自动填充了策略
  const autoPolicy = (r.json as any).policyAutoPopulated;
  if (autoPolicy) {
    safeLog(`paired: 云端已自动配置工具策略 (allowedTools=${autoPolicy.allowedToolsCount} 个)`);
  }

  await saveConfigFile(cfgPath, { apiBase, deviceId, deviceToken, enrolledAt: new Date().toISOString(), deviceType, os: osName, agentVersion: v });
  safeLog(`paired: deviceId=${deviceId} tokenSha256_8=${sha256_8(deviceToken)} config=${cfgPath} capabilities=${capabilities.length}`);
}

/**
 * 内置插件注册表：名称 → 动态导入路径
 * 新增内置插件只需在此添加一行，无需修改 initPlugins 逻辑
 */
const BUILTIN_PLUGIN_MAP: Record<string, () => Promise<any>> = {
  file: () => import("./plugins/filePlugin"),
  browser: () => import("./plugins/browserPlugin"),
  "desktop-control": () => import("./plugins/desktopControlPlugin"),
  clipboard: () => import("./plugins/clipboardPlugin"),
  evidence: () => import("./plugins/evidencePlugin"),
  "gui-automation": () => import("./plugins/guiAutomationPlugin"),
};

/**
 * 内置别名："desktop" → 展开为全部5个子插件
 */
const BUILTIN_ALIASES: Record<string, string[]> = {
  desktop: ["file", "browser", "desktop-control", "clipboard", "evidence"],
};

async function initPlugins() {
  // 1. 根据环境变量决定加载哪些内置插件
  //    未设置 → 不加载任何内置插件（收缩默认，遵循轻量化内核原则）
  //    "none" → 不加载任何内置插件（纯外部插件模式，用于 IoT/机器人/工厂）
  //    "desktop" → 仅加载 desktop
  //    "desktop,gui-automation" → 指定多个
  const builtinEnv = process.env.DEVICE_AGENT_BUILTIN_PLUGINS;
  const builtinRaw =
    builtinEnv === undefined || builtinEnv === "" || builtinEnv === "none"
      ? []
      : builtinEnv.split(",").map((s) => s.trim()).filter(Boolean);
  // 展开别名（如 "desktop" → 5个子插件），去重
  const builtinList = Array.from(new Set(builtinRaw.flatMap((name) => BUILTIN_ALIASES[name] ?? [name])));

  for (const name of builtinList) {
    const loader = BUILTIN_PLUGIN_MAP[name];
    if (!loader) {
      safeError(`unknown_builtin_plugin: "${name}"（可用: ${Object.keys(BUILTIN_PLUGIN_MAP).join(", ")}）`);
      continue;
    }
    try {
      const mod = await loader();
      const result = await initPlugin(mod.default ?? mod);
      if (!result.success) {
        safeError(`builtin_plugin_init_failed: ${name} - ${result.error ?? "unknown"}`);
      }
    } catch (e: any) {
      safeError(`builtin_plugin_load_failed: ${name} - ${e?.message ?? "unknown"}`);
    }
  }
  if (builtinList.length === 0) {
    safeLog("builtin_plugins: none（轻量模式，仅加载内核；设置 DEVICE_AGENT_BUILTIN_PLUGINS=desktop 可启用全部桌面插件）");
  }

  // 2. 从环境变量指定的目录加载外部插件（逗号分隔多个目录）
  const pluginDirs = process.env.DEVICE_AGENT_PLUGIN_DIRS;
  if (pluginDirs) {
    for (const dir of pluginDirs.split(",").map((d) => d.trim()).filter(Boolean)) {
      try {
        const loaded = await loadPluginsFromDir(dir);
        if (loaded.length) safeLog(`plugins_loaded: dir=${dir} plugins=${loaded.join(",")}`);
      } catch (e: any) {
        safeError(`plugin_dir_error: ${dir} - ${e?.message ?? "unknown"}`);
      }
    }
  }

  const all = listPlugins();
  safeLog(`plugins_ready: ${all.map((p) => p.name).join(", ")} (${all.length} 个插件)`);
}

async function cmdRun(opts: Record<string, string | boolean>) {
  const cfgPath = getStringOpt(opts, "config") || defaultConfigPath();
  const cfg = await loadConfigFile(cfgPath);
  if (!cfg) throw new Error("missing_config");

  const apiBase = cfg.apiBase ?? resolveApiBase(opts);
  await initDeviceRuntime(cfg, apiBase);

  // 进程退出时关闭会话管理器
  const cleanupSessionManager = () => { shutdownSessionManager(); };
  process.on("exit", cleanupSessionManager);
  process.on("SIGINT", cleanupSessionManager);
  process.on("SIGTERM", cleanupSessionManager);

  // ── 传输模式选择：优先 WebSocket，失败降级 HTTP 轮询 ──────────
  const transportMode = (process.env.DEVICE_AGENT_TRANSPORT ?? "auto").toLowerCase();
  const useWs = transportMode === "ws" || transportMode === "auto";
  const useHttpFallback = transportMode !== "ws"; // ws-only 模式不降级

  if (useWs) {
    try {
      safeLog("[device-agent] 尝试 WebSocket 连接...");
      const wsAgent = await createWebSocketDeviceAgent(
        { ...cfg, apiBase: cfg.apiBase ?? resolveApiBase(opts) },
        async (q) => {
          if (process.env.DEVICE_AGENT_AUTO_CONFIRM === "true" || process.env.AUTO_CONFIRM === "true") return true;
          return confirmPrompt({ question: q, defaultNo: true });
        },
      );
      safeLog("[device-agent] WebSocket 连接成功，进入 WS 模式");

      // WS 模式下保持进程运行，监听进程退出信号
      const wsCleanup = () => { wsAgent.stop(); };
      process.on("SIGINT", wsCleanup);
      process.on("SIGTERM", wsCleanup);

      // 等待 WS agent 停止（会在重连次数耗尽或 needReEnroll 时停止）
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          // WebSocketDeviceAgent 内部 stop() 后 ws 会置 null
          if (wsAgent.needReEnroll) {
            clearInterval(check);
            safeLog("[device-agent] WS 模式要求重新配对");
            resolve();
          }
        }, 5000);
        check.unref();
      });

      safeLog("device-agent exited: ws-stopped");
      return;
    } catch (wsErr: any) {
      safeLog(`[device-agent] WebSocket 连接失败: ${wsErr?.message ?? "unknown"}`);
      if (!useHttpFallback) {
        safeError("[device-agent] WS-only 模式，不降级 HTTP，退出");
        return;
      }
      safeLog("[device-agent] 降级到 HTTP 轮询模式...");
    }
  }

  // ── HTTP 轮询模式（原有逻辑） ────────────────────────
  const heartbeatIntervalMs = Number(getStringOpt(opts, "heartbeatMs") || "30000");
  const pollIntervalMs = Number(getStringOpt(opts, "pollMs") || "5000");
  // 空闲超时：默认5分钟无任务自动退出（轻量化设计），设为0禁用
  const idleTimeoutMs = Number(getStringOpt(opts, "idleTimeoutMs") || "300000");
  const result = await runLoop({
    cfg,
    confirmFn: async (q) => {
      // 环境变量 DEVICE_AGENT_AUTO_CONFIRM=true 时自动确认
      if (process.env.DEVICE_AGENT_AUTO_CONFIRM === "true" || process.env.AUTO_CONFIRM === "true") {
        return true;
      }
      return confirmPrompt({ question: q, defaultNo: true });
    },
    heartbeatIntervalMs,
    pollIntervalMs,
    idleTimeoutMs,
  });
  safeLog(`device-agent exited: ${result.stopReason}`);
}

async function cmdTray() {
  safeLog("启动托盘模式...");
  // 尝试加载配置以初始化审计和访问控制
  try {
    const cfg = await loadConfigFile(defaultConfigPath());
    if (cfg) {
      const apiBase = cfg.apiBase ?? "http://localhost:3001";
      await initDeviceRuntime(cfg, apiBase);
    }
  } catch {
    // 配置不存在时使用默认值
    initAudit({ deviceId: "unknown", enabled: process.env.AUDIT_ENABLED !== "false" });
  }
  await startTray();
  // 托盘模式下保持进程运行
  await new Promise(() => {});
}

async function main() {
  const { command, options } = parseCli(process.argv);

  // run 和 tray 命令需要单实例：自动杀死旧实例，启动新实例
  if (command === "run" || command === "tray") {
    const killed = await killExistingInstance();
    if (killed) safeLog("已关闭旧的 device-agent 实例");
    await acquireLock();
    process.on("exit", () => { releaseLock().catch(() => {}); });
    process.on("SIGINT", () => { releaseLock().catch(() => {}); process.exit(0); });
    process.on("SIGTERM", () => { releaseLock().catch(() => {}); process.exit(0); });
  }

  // 在执行任何命令前先加载插件
  await initPlugins();
  try {
    if (command === "pair") await cmdPair(options);
    else if (command === "run") await cmdRun(options);
    else if (command === "tray") await cmdTray();
    else {
      safeLog("openslin-device-agent 命令：");
      safeLog("  pair --pairingCode <配对码> [--apiBase <地址>] [--config <路径>] [--deviceType desktop|mobile]");
      safeLog("        配对设备到服务器");
      safeLog("  run [--config <路径>] [--heartbeatMs <毫秒>] [--pollMs <毫秒>] [--idleTimeoutMs <毫秒>]");
      safeLog("        命令行模式运行（空闲5分钟自动退出）");
      safeLog("  tray");
      safeLog("        托盘模式运行（常驻后台，右键菜单控制）");
      safeLog("");
      safeLog("外部插件：设置 DEVICE_AGENT_PLUGIN_DIRS 环境变量指向插件目录");
      safeLog("环境变量：");
      safeLog("  DEVICE_AGENT_BUILTIN_PLUGINS  内置插件（默认 none；如需桌面能力可设为 desktop 或 desktop,gui-automation）");
      safeLog("  DEVICE_AGENT_LIGHTWEIGHT=true 轻量模式（跳过 accessControl/taskQueue）");
      safeLog("  DEVICE_AGENT_TRANSPORT       传输模式: auto(WS优先,降级HTTP) | ws | http");
      safeLog(`已加载插件：${listPlugins().map((p) => p.name).join(", ")}（别名: desktop → file,browser,desktop-control,clipboard,evidence）`);
    }
  } catch (e: any) {
    safeError(String(e?.message ?? "失败"));
    process.exitCode = 1;
  }
}

main();
