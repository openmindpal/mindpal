import fs from "node:fs";
import path from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════
 * 灵智Mindpal Device-OS 内核清单 (KERNEL MANIFEST)
 * ═══════════════════════════════════════════════════════════════
 *
 * 本文件冻结端侧 OS 内核模块列表。
 *
 * **规则：**
 * 1. 只有本清单声明的模块才允许存在于 kernel/ 目录中。
 * 2. 任何新增内核模块必须经过架构评审并更新此清单。
 * 3. browser / desktop / gui / vision / robot / plc / sensor /
 *    camera / vehicle / tray / streaming 等一律归为插件层，
 *    禁止再混入内核。
 *
 * **内核八大基石：**
 *
 * | # | 模块                | 文件                        | 职责                                                       |
 * |---|---------------------|-----------------------------|-----------------------------------------------------------|
 * | 1 | DeviceIdentity      | kernel/identity.ts          | 设备身份与配对：enrollment / pair / revoke / rotation / re-enroll |
 * | 2 | Auth & Policy       | kernel/auth.ts              | 安全认证、策略下发、签名校验、策略缓存与失效                 |
 * | 3 | CapabilityRegistry  | kernel/capabilityRegistry.ts| 工具/能力注册与发现：声明、注册、查询、前缀匹配               |
 * | 4 | TaskExecutor        | kernel/taskExecutor.ts      | 任务领取、执行、回传：统一七态状态机                          |
 * | 5 | Session             | kernel/session.ts           | 会话、心跳、健康检查、资源快照、能力快照                      |
 * | 6 | Audit & Evidence    | kernel/audit.ts             | 审计、证据、回放：不可篡改日志、artifact 上传、replay trace    |
 * | 7 | Transport           | kernel/transport.ts         | 多通道通信：WS/HTTP/MQ 统一信封、重试、幂等、ACK/NACK        |
 * | 8 | PluginLifecycle     | kernel/pluginLifecycle.ts   | 插件隔离、资源限制、生命周期：init→register→health→execute→dispose→upgrade/rollback |
 *
 * **辅助内核文件（非独立模块，服务于上述八大基石）：**
 * - kernel/types.ts        — 内核级公共类型定义
 * - kernel/config.ts       — 通用配置读写（不含身份逻辑）
 * - kernel/log.ts          — (已合并至上层 log.ts)
 * - kernel/index.ts        — 内核统一导出入口
 *
 * @layer kernel
 * @frozen 2026-04-08
 */

// ── 内核模块枚举 ─────────────────────────────────────────────

export const KERNEL_MODULES = [
  "identity",
  "auth",
  "capabilityRegistry",
  "taskExecutor",
  "session",
  "audit",
  "transport",
  "pluginLifecycle",
] as const;

export type KernelModule = (typeof KERNEL_MODULES)[number];

// ── 内核模块描述 ─────────────────────────────────────────────

export interface KernelModuleDescriptor {
  name: KernelModule;
  file: string;
  description: string;
  dependencies: KernelModule[];
}

export const KERNEL_MODULE_DESCRIPTORS: Record<KernelModule, KernelModuleDescriptor> = {
  identity: {
    name: "identity",
    file: "kernel/identity.ts",
    description: "设备身份与配对：enrollment / pair / revoke / rotation / re-enroll",
    dependencies: ["transport", "audit"],
  },
  auth: {
    name: "auth",
    file: "kernel/auth.ts",
    description: "安全认证、策略下发、签名校验、策略版本管理、策略缓存与失效",
    dependencies: ["identity", "audit"],
  },
  capabilityRegistry: {
    name: "capabilityRegistry",
    file: "kernel/capabilityRegistry.ts",
    description: "工具/能力注册与发现：声明、注册、查询、前缀匹配、风险分级",
    dependencies: ["auth"],
  },
  taskExecutor: {
    name: "taskExecutor",
    file: "kernel/taskExecutor.ts",
    description: "任务领取、执行、回传：统一 pending→claimed→running→succeeded→failed→canceled→timed_out 七态状态机",
    dependencies: ["capabilityRegistry", "auth", "audit", "transport"],
  },
  session: {
    name: "session",
    file: "kernel/session.ts",
    description: "会话管理、心跳、健康检查、资源快照、能力快照",
    dependencies: ["transport", "identity"],
  },
  audit: {
    name: "audit",
    file: "kernel/audit.ts",
    description: "审计、证据、回放：不可篡改日志、artifact 上传、replay trace",
    dependencies: [],
  },
  transport: {
    name: "transport",
    file: "kernel/transport.ts",
    description: "多通道通信：WS/HTTP/MQ 统一信封、重试、幂等、ACK/NACK、超时、回执",
    dependencies: ["audit"],
  },
  pluginLifecycle: {
    name: "pluginLifecycle",
    file: "kernel/pluginLifecycle.ts",
    description: "插件隔离、资源限制、生命周期：init→registered→healthcheck→ready→execute→dispose→upgraded/rolledBack",
    dependencies: ["capabilityRegistry", "audit"],
  },
};

// ── 禁止进入内核的关键词（用于架构守卫扫描） ──────────────────

export const NON_KERNEL_KEYWORDS = [
  "browser", "desktop", "gui", "vision", "robot", "plc",
  "sensor", "camera", "vehicle", "streaming",
  "edge", "inference", "ocr", "perception", "localVision",
  "home", "appliance", "traffic", "energy", "elevator",
] as const;

const AUXILIARY_KERNEL_FILES = ["types.ts", "config.ts", "index.ts", "toolFeatureFlags.ts", "toolMetrics.ts"];

export type BoundaryValidationIssue = {
  scope: "kernel" | "plugin";
  code: string;
  detail: string;
};

function resolveDeclaredFile(baseDir: string, relativeFile: string): string {
  const direct = path.join(baseDir, relativeFile);
  if (fs.existsSync(direct)) return direct;
  return path.join(baseDir, relativeFile.replace(/\.ts$/i, ".js"));
}

export function validateKernelManifest(baseDir = path.resolve(__dirname, "..")): BoundaryValidationIssue[] {
  const issues: BoundaryValidationIssue[] = [];
  const kernelDir = path.join(baseDir, "kernel");
  const allowedFiles = new Set([
    ...Object.values(KERNEL_MODULE_DESCRIPTORS).map((descriptor) => path.basename(descriptor.file)),
    ...AUXILIARY_KERNEL_FILES,
    "KERNEL_MANIFEST.ts",
    "KERNEL_MANIFEST.js",
    "PLUGIN_BOUNDARY.ts",
    "PLUGIN_BOUNDARY.js",
  ]);

  for (const descriptor of Object.values(KERNEL_MODULE_DESCRIPTORS)) {
    if (!KERNEL_MODULES.includes(descriptor.name)) {
      issues.push({ scope: "kernel", code: "unknown_manifest_module", detail: descriptor.name });
    }
    const resolved = resolveDeclaredFile(baseDir, descriptor.file);
    if (!fs.existsSync(resolved)) {
      issues.push({ scope: "kernel", code: "missing_manifest_file", detail: descriptor.file });
    }
  }

  if (fs.existsSync(kernelDir)) {
    for (const entry of fs.readdirSync(kernelDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|js)$/i.test(entry.name)) continue;
      if (!allowedFiles.has(entry.name)) {
        issues.push({ scope: "kernel", code: "unexpected_kernel_file", detail: entry.name });
      }
    }
  }

  return issues;
}

export function assertKernelManifest(baseDir = path.resolve(__dirname, "..")): void {
  const issues = validateKernelManifest(baseDir);
  if (issues.length === 0) return;
  const detail = issues.map((issue) => `${issue.scope}:${issue.code}:${issue.detail}`).join("; ");
  throw new Error(`kernel_manifest_invalid: ${detail}`);
}
