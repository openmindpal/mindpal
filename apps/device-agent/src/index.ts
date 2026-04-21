#!/usr/bin/env node
import os from "node:os";
import { parseCli, getStringOpt } from "./cli";
import { defaultConfigPath, loadConfigFile, saveConfigFile, killExistingInstance, acquireLock, releaseLock } from "./config";
import type { DeviceType } from "./config";
import { apiPostJson } from "./api";
import { runLoop } from "./agent";
import { createWebSocketDeviceAgent } from "./websocketClient";
import { confirmPrompt } from "./prompt";
import { safeError, safeLog, sha256_8 } from "./log";
import { resolveDeviceAgentEnv } from "./deviceAgentEnv";
import { listPlugins } from "./kernel/capabilityRegistry";
import { loadPluginsFromDir } from "./pluginRegistry";
import { startTray } from "./tray";
import { initAudit, cleanupOldAuditLogs } from "./kernel/audit";
import { initPlugin } from "./kernel/pluginLifecycle";
import { initSessionManager, shutdownSessionManager } from "./kernel/session";
import { initPolicyCache } from "./kernel/auth";
import { assertKernelManifest, assertPluginBoundary } from "./kernel";

function resolveApiBase(opts: Record<string, string | boolean>) {
  return getStringOpt(opts, "apiBase") || resolveDeviceAgentEnv().apiBase;
}

/**
 * 共享的设备运行时初始化逻辑（审计、访问控制、任务队列、会话管理、策略缓存）。
 * cmdRun 和 cmdTray 共用，消除重复初始化代码。
 */
async function initDeviceRuntime(cfg: { deviceId: string; deviceToken: string; apiBase?: string; os?: string; agentVersion?: string }, apiBase: string) {
  assertKernelManifest();
  assertPluginBoundary();
  const daCfg = resolveDeviceAgentEnv();

  // 初始化审计日志
  initAudit({ deviceId: cfg.deviceId, enabled: daCfg.auditEnabled });
  cleanupOldAuditLogs(30).catch(() => {});

  // 访问控制与任务队列：按需加载（轻量模式可跳过）
  if (!daCfg.lightweight) {
    const { initAccessControl, cleanupExpiredContexts } = await import("./kernel/auth");
    initAccessControl({
      secretKey: daCfg.secretKey,
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
    enabled: daCfg.sessionHeartbeatEnabled,
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
    enabled: daCfg.policyCacheEnabled,
  });
}

function agentVersion() {
  return resolveDeviceAgentEnv().agentVersion;
}

function detectOs() {
  return resolveDeviceAgentEnv().agentOs;
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

  // ── 元数据驱动：将插件配置写入配置文件 ────────────
  // 优先使用云端下发的 pluginPolicy，否则使用设备类型默认值
  const cloudPluginPolicy = (r.json as any).pluginPolicy;
  const pluginConfig = cloudPluginPolicy
    ? { builtinPlugins: cloudPluginPolicy.builtinPlugins ?? [], pluginDirs: cloudPluginPolicy.pluginDirs ?? [], updatedAt: new Date().toISOString(), source: "cloud" as const }
    : { builtinPlugins: getDefaultPluginsForDeviceType(deviceType), updatedAt: new Date().toISOString(), source: "local" as const };

  await saveConfigFile(cfgPath, { apiBase, deviceId, deviceToken, enrolledAt: new Date().toISOString(), deviceType, os: osName, agentVersion: v, pluginConfig });
  safeLog(`paired: deviceId=${deviceId} tokenSha256_8=${sha256_8(deviceToken)} config=${cfgPath} capabilities=${capabilities.length} pluginSource=${pluginConfig.source}`);
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

/**
 * 设备类型 → 默认内置插件映射（元数据驱动）
 * 当配置文件中无 pluginConfig 时，根据设备类型自动推断应加载的插件集。
 * 新增设备类型只需在此添加映射，无需修改加载逻辑。
 */
const DEVICE_TYPE_DEFAULT_PLUGINS: Record<string, string[]> = {
  desktop: ["desktop"],
  mobile: [],
  iot: [],
  robot: [],
  vehicle: [],
  home: [],
  gateway: [],
};

/** 根据设备类型获取默认插件列表 */
export function getDefaultPluginsForDeviceType(deviceType: string): string[] {
  return DEVICE_TYPE_DEFAULT_PLUGINS[deviceType] ?? [];
}

/**
 * 加载插件（元数据驱动）。
 * 插件列表由配置文件 pluginConfig 或设备类型默认值决定，
 * 不再依赖 DEVICE_AGENT_BUILTIN_PLUGINS 环境变量。
 *
 * @param builtinNames - 要加载的内置插件名称（支持别名如 "desktop"）
 * @param pluginDirs  - 外部插件目录列表
 */
async function initPlugins(builtinNames: string[] = [], pluginDirs: string[] = []) {
  // 1. 展开别名（如 "desktop" → 5个子插件），去重
  const builtinList = Array.from(new Set(builtinNames.flatMap((name) => BUILTIN_ALIASES[name] ?? [name])));

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
    safeLog("builtin_plugins: none（轻量内核模式）");
  } else {
    safeLog(`builtin_plugins: ${builtinList.join(", ")}（来源: 配置文件元数据）`);
  }

  // 2. 从配置文件指定的目录加载外部插件
  for (const dir of pluginDirs) {
    try {
      const loaded = await loadPluginsFromDir(dir);
      if (loaded.length) safeLog(`plugins_loaded: dir=${dir} plugins=${loaded.join(",")}`);
    } catch (e: any) {
      safeError(`plugin_dir_error: ${dir} - ${e?.message ?? "unknown"}`);
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
  const daCfg = resolveDeviceAgentEnv();
  const transportMode = daCfg.transport;
  const useWs = transportMode === "ws" || transportMode === "auto";
  const useHttpFallback = transportMode !== "ws"; // ws-only 模式不降级

  if (useWs) {
    try {
      safeLog("[device-agent] 尝试 WebSocket 连接...");
      const wsAgent = await createWebSocketDeviceAgent(
        { ...cfg, apiBase: cfg.apiBase ?? resolveApiBase(opts) },
        async (q) => {
          if (daCfg.autoConfirm) return true;
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
      if (daCfg.autoConfirm) {
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
    initAudit({ deviceId: "unknown", enabled: resolveDeviceAgentEnv().auditEnabled });
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

  // ── 元数据驱动：从配置文件/设备类型推断插件列表，不依赖环境变量 ──
  let builtinPlugins: string[] = [];
  let pluginDirs: string[] = [];

  if (command === "run" || command === "tray") {
    // 运行/托盘模式：从配置文件读取插件元数据
    const cfgPath = getStringOpt(options, "config") || defaultConfigPath();
    try {
      const cfg = await loadConfigFile(cfgPath);
      if (cfg?.pluginConfig) {
        // 配置文件中有明确的 pluginConfig → 使用它（可能来自云端策略下发）
        builtinPlugins = cfg.pluginConfig.builtinPlugins ?? [];
        pluginDirs = cfg.pluginConfig.pluginDirs ?? [];
        safeLog(`[plugin-config] 来源: ${cfg.pluginConfig.source ?? "local"}, 插件: [${builtinPlugins.join(",")}]`);
      } else if (cfg?.deviceType) {
        // 配置文件存在但无 pluginConfig → 使用设备类型默认值
        builtinPlugins = getDefaultPluginsForDeviceType(cfg.deviceType);
        safeLog(`[plugin-config] 来源: 设备类型默认值 (${cfg.deviceType}), 插件: [${builtinPlugins.join(",")}]`);
      }
    } catch {
      // 配置文件不存在时，根据 OS 推断设备类型
      builtinPlugins = getDefaultPluginsForDeviceType("desktop");
      safeLog(`[plugin-config] 来源: OS推断默认值 (desktop), 插件: [${builtinPlugins.join(",")}]`);
    }
  } else if (command === "pair") {
    // 配对模式：根据 CLI 指定的设备类型加载默认插件（用于上报能力清单）
    const deviceType = detectDeviceType(options);
    builtinPlugins = getDefaultPluginsForDeviceType(deviceType);
    safeLog(`[plugin-config] 来源: 配对设备类型 (${deviceType}), 插件: [${builtinPlugins.join(",")}]`);
  }
  // else: help 命令不加载插件

  await initPlugins(builtinPlugins, pluginDirs);

  try {
    if (command === "pair") await cmdPair(options);
    else if (command === "run") await cmdRun(options);
    else if (command === "tray") await cmdTray();
    else {
      safeLog("openslin-device-agent 命令：");
      safeLog("  pair --pairingCode <配对码> [--apiBase <地址>] [--config <路径>] [--deviceType desktop|mobile]");
      safeLog("        配对设备到服务器（自动根据设备类型加载对应插件）");
      safeLog("  run [--config <路径>] [--heartbeatMs <毫秒>] [--pollMs <毫秒>] [--idleTimeoutMs <毫秒>]");
      safeLog("        命令行模式运行（从配置文件元数据加载插件策略）");
      safeLog("  tray");
      safeLog("        托盘模式运行（常驻后台，右键菜单控制）");
      safeLog("");
      safeLog("插件治理（元数据驱动，无需手动设置环境变量）：");
      safeLog("  配对时根据设备类型自动确定内置插件 → 写入配置文件");
      safeLog("  运行时从配置文件读取 pluginConfig，支持云端策略动态下发");
      safeLog("  设备类型默认插件: desktop→[desktop] | mobile/iot/robot→[]");
      safeLog(`  别名展开: desktop → file,browser,desktop-control,clipboard,evidence`);
      safeLog(`已加载插件：${listPlugins().map((p) => p.name).join(", ")} (${listPlugins().length} 个)`);
    }
  } catch (e: any) {
    safeError(String(e?.message ?? "失败"));
    process.exitCode = 1;
  }
}

main();
