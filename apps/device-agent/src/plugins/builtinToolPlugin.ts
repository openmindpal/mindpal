/**
 * 内置工具插件 — noop / echo
 *
 * 将原先散落在 executors.ts、taskExecutor.ts 中的 noop/echo 硬编码逻辑
 * 提取为标准 DeviceToolPlugin，通过插件注册表统一分发。
 *
 * 遵循 P4 动态化规范：不向 kernel/orchestrator 注入特殊分支。
 *
 * @layer plugin
 */
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult, CapabilityDescriptor } from "../kernel/types";

const BUILTIN_CAPABILITIES: CapabilityDescriptor[] = [
  {
    toolRef: "noop",
    riskLevel: "low",
    version: "1",
    tags: ["builtin", "noop"],
    description: "空操作工具，立即返回成功（用于健康检查/心跳探测）",
  },
  {
    toolRef: "echo",
    riskLevel: "low",
    version: "1",
    tags: ["builtin", "echo"],
    description: "回显工具，返回输入键列表（用于调试/连通性验证）",
  },
];

async function executeBuiltin(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const { toolName, input } = ctx;

  if (toolName === "noop") {
    return { status: "succeeded", outputDigest: { ok: true } };
  }

  if (toolName === "echo") {
    return {
      status: "succeeded",
      outputDigest: {
        inputKeys: Object.keys(input).slice(0, 50),
        keyCount: Object.keys(input).length,
      },
    };
  }

  return {
    status: "failed",
    errorCategory: "unsupported_tool",
    outputDigest: { toolName, plugin: "builtin" },
  };
}

const builtinToolPlugin: DeviceToolPlugin = {
  name: "builtin",
  version: "1.0.0",
  toolPrefixes: ["noop", "echo"],
  toolNames: ["noop", "echo"],
  capabilities: BUILTIN_CAPABILITIES,
  resourceLimits: {
    maxMemoryMb: 1,
    maxCpuPercent: 1,
    maxConcurrency: 100,
    maxExecutionTimeMs: 1000,
  },
  execute: executeBuiltin,
};

export default builtinToolPlugin;
