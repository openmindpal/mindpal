/**
 * @openslin/device-agent-sdk — 灵智MindPal端侧代理SDK
 *
 * 可嵌入的设备智能体运行时内核，提供：
 * - 设备身份管理与安全认证
 * - 能力注册与工具发现
 * - 任务执行引擎
 * - 插件生命周期管理
 * - 审计与证据链
 * - 多通道通信
 * - 灰度开关与熔断器
 * - 工具指标采集
 *
 * @example
 * ```typescript
 * import { createDeviceAgentKernel } from '@openslin/device-agent-sdk';
 *
 * const kernel = await createDeviceAgentKernel({
 *   deviceId: 'my-robot-001',
 *   deviceToken: 'xxx',
 *   apiBase: 'https://api.example.com',
 *   deviceType: 'robot',
 * });
 *
 * await kernel.registerPlugin(myCustomPlugin);
 * const result = await kernel.executeDeviceTool({ toolRef: 'device.sensor.read', input: {} });
 * ```
 */

// ── 内核完整 API re-export ──────────────────────────────────
export * from './kernel/index';

// ── 通信层 re-export ────────────────────────────────────────
export * from './transport/index';

// ── 配置管理 re-export ──────────────────────────────────────
// config.ts 与 kernel/identity.ts 有重复导出，仅导出 config 独有的类型
// DeviceAgentFullConfig 包含 pluginConfig 字段，是 kernel DeviceAgentConfig 的超集
export type { DeviceType, PluginConfig, DeviceAgentConfig as DeviceAgentFullConfig } from './config';

// ── SDK 工厂函数与高层接口 ──────────────────────────────────

import type {
  DeviceToolPlugin,
  ToolExecutionResult,
  CapabilityDescriptor,
  DeviceType,
  DeviceClaimEnvelope,
} from './kernel/types';

import { initAudit } from './kernel/audit';
import { initAccessControl } from './kernel/auth';
import { getDefaultExecutionSession, initSessionManager } from './kernel/session';
import { findPluginForTool, listCapabilities } from './kernel/capabilityRegistry';
import { executeDeviceTool } from './kernel/taskExecutor';
import { initPlugin, disposePlugin, disposeAllPlugins, setCurrentDeviceType, setSecretKeyProvider } from './kernel/pluginLifecycle';

/**
 * SDK初始化选项 — 依赖注入方式，不直接读取环境变量
 */
export interface DeviceAgentKernelOptions {
  /** 设备唯一标识 */
  deviceId: string;
  /** 设备认证令牌 */
  deviceToken: string;
  /** 后端 API 基地址 */
  apiBase: string;
  /** 设备类型 */
  deviceType: DeviceType;
  /** 是否启用审计日志（默认 true） */
  auditEnabled?: boolean;
  /** 审计日志目录（可选） */
  auditDir?: string;
  /** 轻量模式 — 跳过会话管理器和策略缓存初始化 */
  lightweight?: boolean;
  /** 插件签名密钥（可选） */
  secretKey?: string;
  /** 心跳发送回调（非轻量模式必须） */
  apiSendHeartbeat?: (body: any) => Promise<any>;
  /** 心跳间隔毫秒（默认 30000） */
  heartbeatIntervalMs?: number;
  /** 设备 OS 标识（可选） */
  os?: string;
}

/** 执行设备工具所需的参数 */
export interface ExecuteDeviceToolParams {
  claim: DeviceClaimEnvelope;
  confirmFn: (q: string) => Promise<boolean>;
}

/**
 * SDK内核实例接口
 */
export interface IDeviceAgentKernel {
  /** 执行设备工具 */
  executeDeviceTool(params: ExecuteDeviceToolParams): Promise<ToolExecutionResult>;
  /** 注册插件 */
  registerPlugin(plugin: DeviceToolPlugin): Promise<void>;
  /** 注销插件 */
  unregisterPlugin(name: string): Promise<void>;
  /** 列出所有已注册能力 */
  listCapabilities(): CapabilityDescriptor[];
  /** 查找工具对应的插件 */
  findPluginForTool(toolRef: string): DeviceToolPlugin | null;
  /** 销毁内核，释放所有插件资源 */
  dispose(): Promise<void>;
}

/**
 * 创建设备代理内核实例 — SDK主入口
 *
 * 封装内核初始化流程，提供面向集成方的简洁 API。
 *
 * @param options - SDK初始化选项
 * @returns 内核实例
 *
 * @example
 * ```typescript
 * import { createDeviceAgentKernel } from '@openslin/device-agent-sdk';
 *
 * const kernel = await createDeviceAgentKernel({
 *   deviceId: 'my-robot-001',
 *   deviceToken: 'xxx',
 *   apiBase: 'https://api.example.com',
 *   deviceType: 'robot',
 * });
 *
 * // 注册自定义插件
 * await kernel.registerPlugin(myCustomPlugin);
 *
 * // 执行工具
 * const result = await kernel.executeDeviceTool({
 *   toolRef: 'device.sensor.read',
 *   input: {},
 * });
 *
 * // 销毁
 * await kernel.dispose();
 * ```
 */
export async function createDeviceAgentKernel(
  options: DeviceAgentKernelOptions
): Promise<IDeviceAgentKernel> {
  // ── 1. 设置设备类型 ──────────────────────────────────────
  setCurrentDeviceType(options.deviceType);

  // ── 2. 注入密钥提供者（如果提供） ────────────────────────
  if (options.secretKey) {
    const key = options.secretKey;
    setSecretKeyProvider(() => key);
  }

  // ── 3. 初始化审计模块 ────────────────────────────────────
  if (options.auditEnabled !== false) {
    initAudit({
      deviceId: options.deviceId,
      auditDir: options.auditDir,
      enabled: true,
    });
  }

  // ── 4. 初始化认证与策略 ──────────────────────────────────
  if (!options.lightweight) {
    initAccessControl({
      secretKey: options.secretKey,
    });
  }

  // ── 5. 初始化任务队列 ────────────────────────────────────
  getDefaultExecutionSession().initTaskQueue();

  // ── 6. 初始化会话管理器（非轻量模式） ────────────────────
  if (!options.lightweight && options.apiSendHeartbeat) {
    initSessionManager(
      {
        apiBase: options.apiBase,
        deviceToken: options.deviceToken,
        deviceId: options.deviceId,
        intervalMs: options.heartbeatIntervalMs ?? 30_000,
        os: options.os,
      },
      options.apiSendHeartbeat,
    );
  }

  // ── 返回内核实例 ─────────────────────────────────────────
  return {
    async executeDeviceTool(params: ExecuteDeviceToolParams): Promise<ToolExecutionResult> {
      return executeDeviceTool({
        cfg: { apiBase: options.apiBase, deviceToken: options.deviceToken },
        claim: params.claim,
        confirmFn: params.confirmFn,
      });
    },

    async registerPlugin(plugin: DeviceToolPlugin): Promise<void> {
      const result = await initPlugin(plugin);
      if (!result.success) {
        throw new Error(`Plugin registration failed: ${result.error}`);
      }
    },

    async unregisterPlugin(name: string): Promise<void> {
      const result = await disposePlugin(name);
      if (!result.success) {
        throw new Error(`Plugin unregister failed: ${result.error}`);
      }
    },

    listCapabilities(): CapabilityDescriptor[] {
      return listCapabilities();
    },

    findPluginForTool(toolRef: string): DeviceToolPlugin | null {
      return findPluginForTool(toolRef);
    },

    async dispose(): Promise<void> {
      await disposeAllPlugins();
    },
  };
}
