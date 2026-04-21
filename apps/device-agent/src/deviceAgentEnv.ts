/**
 * deviceAgentEnv.ts — device-agent 环境变量集中读取
 *
 * 消除各文件散落的 process.env.* 直接访问，所有配置统一从本模块获取。
 * 运行时只读取一次 env，后续调用返回缓存值。
 */
import os from "node:os";

export interface DeviceAgentEnvConfig {
  /** API 服务基础 URL */
  apiBase: string;
  /** 审计日志开关 */
  auditEnabled: boolean;
  /** 轻量模式（跳过访问控制和任务队列） */
  lightweight: boolean;
  /** 访问控制密钥 */
  secretKey: string | undefined;
  /** 会话心跳开关 */
  sessionHeartbeatEnabled: boolean;
  /** 策略缓存开关 */
  policyCacheEnabled: boolean;
  /** 代理版本号 */
  agentVersion: string;
  /** 操作系统标识 */
  agentOs: string;
  /** 传输模式: auto / ws / http */
  transport: string;
  /** 自动确认（跳过人工交互） */
  autoConfirm: boolean;
  /** GUI 步骤间延迟 (ms) */
  guiStepDelayMs: number;
  /** OCR 缓存 TTL (ms) */
  ocrCacheTtlMs: number;
  /** OCR 缓存最大条目数 */
  ocrCacheMax: number;
  /** 浏览器 CDP 调试 URL */
  browserCdpUrl: string;
  /** 应用启动模式: spawn / exec */
  launchMode: string;
}

let _cached: DeviceAgentEnvConfig | null = null;

/** 从 process.env 一次性解析所有 device-agent 配置 */
export function resolveDeviceAgentEnv(): DeviceAgentEnvConfig {
  if (_cached) return _cached;
  const env = process.env;
  _cached = {
    apiBase: env.API_BASE || "http://localhost:3001",
    auditEnabled: env.AUDIT_ENABLED !== "false",
    lightweight: env.DEVICE_AGENT_LIGHTWEIGHT === "true",
    secretKey: env.DEVICE_AGENT_SECRET_KEY,
    sessionHeartbeatEnabled: env.SESSION_HEARTBEAT_ENABLED !== "false",
    policyCacheEnabled: env.POLICY_CACHE_ENABLED !== "false",
    agentVersion: env.AGENT_VERSION || "1.0.0",
    agentOs: env.AGENT_OS || `${os.platform()}-${os.release()}`,
    transport: (env.DEVICE_AGENT_TRANSPORT ?? "auto").toLowerCase(),
    autoConfirm: env.DEVICE_AGENT_AUTO_CONFIRM === "true" || env.AUTO_CONFIRM === "true",
    guiStepDelayMs: Number(env.DEVICE_AGENT_GUI_STEP_DELAY_MS ?? "200"),
    ocrCacheTtlMs: Math.max(500, Number(env.DEVICE_AGENT_OCR_CACHE_TTL_MS ?? "2000")),
    ocrCacheMax: Math.max(10, Number(env.DEVICE_AGENT_OCR_CACHE_MAX ?? "100")),
    browserCdpUrl: String(env.DEVICE_AGENT_BROWSER_CDP_URL ?? "http://localhost:9222").trim() || "http://localhost:9222",
    launchMode: String(env.DEVICE_AGENT_LAUNCH_MODE ?? "spawn").toLowerCase(),
  };
  return _cached;
}

/** 清除缓存（仅用于测试） */
export function resetDeviceAgentEnvCache() {
  _cached = null;
}
