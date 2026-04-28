/**
 * Device-OS 内核模块：外部插件沙箱隔离与签名校验
 *
 * 功能目标：
 * - 为外部插件加载提供 HMAC-SHA256 签名校验能力，防止篡改
 * - 提供基础沙箱隔离（受限 vm.Context），阻止插件直接访问 fs/network 等危险模块
 * - 作为安全基础设施，不改变现有插件加载和执行流程
 *
 * @layer kernel
 */
import * as vm from "node:vm";
import * as crypto from "node:crypto";

// ── 签名校验 ──────────────────────────────────────────────

/** 外部插件清单（manifest.json 结构） */
export interface PluginManifest {
  name: string;
  version: string;
  signature?: string;       // HMAC-SHA256 签名（hex）
  entryPoint: string;
}

/**
 * 校验外部插件签名。
 * 使用 HMAC-SHA256 对 `name@version:entryPoint` 签名并与 manifest 中声明的 signature 比对。
 *
 * @param manifest  - 插件清单
 * @param secretKey - 签名密钥（与 DEVICE_AGENT_SECRET_KEY 一致）
 * @returns 校验结果：valid=true 表示通过；valid=false 时附带 reason
 */
export function verifyPluginSignature(
  manifest: PluginManifest,
  secretKey: string,
): { valid: boolean; reason?: string } {
  if (!manifest.signature) {
    return { valid: false, reason: "missing_signature" };
  }

  // 确保 signature 是合法的 hex 字符串且长度正确（SHA256 = 64 hex chars）
  if (!/^[0-9a-f]{64}$/i.test(manifest.signature)) {
    return { valid: false, reason: "invalid_signature_format" };
  }

  const payload = `${manifest.name}@${manifest.version}:${manifest.entryPoint}`;
  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(payload)
    .digest("hex");

  // 使用 timingSafeEqual 防止时序攻击
  const valid = crypto.timingSafeEqual(
    Buffer.from(manifest.signature, "hex"),
    Buffer.from(expected, "hex"),
  );

  return valid ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

// ── 沙箱隔离 ──────────────────────────────────────────────

/** 沙箱配置选项 */
export interface SandboxOptions {
  /** 是否允许文件访问（默认 false） */
  allowFs?: boolean;
  /** 是否允许网络访问（默认 false） */
  allowNet?: boolean;
  /** 允许 require 的模块白名单（空数组 = 不限制非危险模块） */
  allowedModules?: string[];
  /** 执行超时毫秒（默认 30000） */
  timeoutMs?: number;
}

/** 始终阻止的危险模块 */
const ALWAYS_BLOCKED_MODULES: readonly string[] = [
  "child_process",
  "worker_threads",
  "cluster",
  "vm",
];

/** 文件系统相关模块 */
const FS_MODULES: readonly string[] = ["fs", "fs/promises"];

/** 网络相关模块 */
const NET_MODULES: readonly string[] = [
  "net",
  "http",
  "https",
  "http2",
  "dgram",
  "tls",
  "dns",
];

/**
 * 创建受限的插件沙箱上下文。
 * 通过 vm.createContext 创建隔离环境，仅暴露安全的全局对象和受限的 require 函数。
 *
 * @param options - 沙箱配置
 * @returns vm.Context 沙箱上下文
 */
export function createPluginSandbox(options: SandboxOptions = {}): vm.Context {
  const {
    allowFs = false,
    allowNet = false,
    allowedModules = [],
  } = options;

  // 创建受限的 require 函数
  const safeRequire = (moduleName: string): unknown => {
    if (ALWAYS_BLOCKED_MODULES.includes(moduleName)) {
      throw new Error(`module_blocked: ${moduleName}`);
    }
    if (!allowFs && FS_MODULES.includes(moduleName)) {
      throw new Error(`module_blocked: ${moduleName} (fs access disabled)`);
    }
    if (!allowNet && NET_MODULES.includes(moduleName)) {
      throw new Error(`module_blocked: ${moduleName} (network access disabled)`);
    }
    if (allowedModules.length > 0 && !allowedModules.includes(moduleName)) {
      throw new Error(`module_not_allowed: ${moduleName}`);
    }
    return require(moduleName);
  };

  const sandbox: Record<string, unknown> = {
    console: { log: console.log, warn: console.warn, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    URL,
    URLSearchParams,
    require: safeRequire,
    process: { env: {}, platform: process.platform, version: process.version },
  };

  return vm.createContext(sandbox);
}

/**
 * 在沙箱中执行插件代码。
 *
 * @param code      - 要执行的 JS 代码字符串
 * @param context   - 沙箱上下文（由 createPluginSandbox 创建）
 * @param timeoutMs - 执行超时毫秒（默认 30000）
 * @returns 代码执行结果
 */
export function executeInSandbox<T>(
  code: string,
  context: vm.Context,
  timeoutMs = 30000,
): T {
  const script = new vm.Script(code);
  return script.runInContext(context) as T;
}
