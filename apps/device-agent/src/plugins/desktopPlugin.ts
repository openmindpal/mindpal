/**
 * 内置桌面插件 — 子插件聚合层。
 * 将 5 个子插件（filePlugin / browserPlugin / desktopControlPlugin / clipboardPlugin / evidencePlugin）
 * 合并为一个统一的 DeviceToolPlugin 接口，支持工具名解析和路由分发。
 */
import type { DeviceToolPlugin } from "../pluginRegistry";
import { normalizeToolName } from "../executors";
import filePlugin from "./filePlugin";
import browserPlugin from "./browserPlugin";
import desktopControlPlugin from "./desktopControlPlugin";
import clipboardPlugin from "./clipboardPlugin";
import evidencePlugin from "./evidencePlugin";

const SUB_PLUGINS = [filePlugin, browserPlugin, desktopControlPlugin, clipboardPlugin, evidencePlugin];

const desktopPlugin: DeviceToolPlugin = {
  name: "desktop",
  version: "1.0.0",
  toolPrefixes: SUB_PLUGINS.flatMap((p) => p.toolPrefixes ?? []),
  capabilities: SUB_PLUGINS.flatMap((p) => p.capabilities ?? []),
  resourceLimits: {
    maxMemoryMb: 50,
    maxCpuPercent: 80,
    maxConcurrency: 2,
    maxExecutionTimeMs: 120000,
  },
  toolNames: SUB_PLUGINS.flatMap((p) => p.toolNames ?? []),

  async execute(ctx) {
    const normalized = normalizeToolName(ctx.toolName);
    const effectiveCtx = normalized !== ctx.toolName ? { ...ctx, toolName: normalized } : ctx;
    for (const plugin of SUB_PLUGINS) {
      if (plugin.toolNames?.includes(effectiveCtx.toolName)) {
        return plugin.execute(effectiveCtx);
      }
    }
    return {
      status: "failed",
      errorCategory: "unsupported_tool",
      outputDigest: { toolName: ctx.toolName, plugin: "desktop" },
    };
  },
};

export default desktopPlugin;
