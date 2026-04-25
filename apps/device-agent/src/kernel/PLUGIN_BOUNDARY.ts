import fs from "node:fs";
import path from "node:path";
import type { BoundaryValidationIssue } from "./KERNEL_MANIFEST";

/**
 * ═══════════════════════════════════════════════════════════════
 * 灵智Mindpal Device-OS 插件边界声明 (PLUGIN BOUNDARY)
 * ═══════════════════════════════════════════════════════════════
 *
 * 本文件声明所有归属于插件层的领域。
 *
 * **规则：**
 * 1. 以下所列域一律为插件，禁止混入 kernel/ 目录。
 * 2. 插件必须通过 kernel/pluginLifecycle 注册和管理。
 * 3. 插件不可直接依赖其他插件，只能依赖 kernel 暴露的公共接口。
 * 4. 新增插件域只需在此文件的 PLUGIN_DOMAINS 中添加一行。
 *
 * @layer plugin
 */

// ── 插件域枚举 ───────────────────────────────────────────────

export const PLUGIN_DOMAINS = [
  // 内置工具
  "builtin",      // noop/echo — 内置工具（健康检查/回显调试）

  // PC / Mac / Linux 桌面
  "desktop",      // device.desktop.* — 桌面操作（截图、启动应用、文件管理等）
  "browser",      // device.browser.* — 浏览器控制（导航、DOM操作、截图等）
  "clipboard",    // device.clipboard.* — 剪贴板读写
  "file",         // device.file.* — 文件系统操作

  // GUI 自动化
  "gui",          // device.gui.* — GUI 自动化（视觉闭环、动作计划执行）
  "vision",       // device.vision.* — 本地视觉原语（截图、OCR、鼠标键盘）

  // 流式执行
  "streaming",    // 流式控制执行器（连续操作流）

  // 感知路由
  "perception",   // 感知提供者路由（Playwright/本地OCR/云端等）

  // ── 以下为预留的外部插件域 ──────────────────────────────────

  // 工业
  "plc",          // device.plc.* — PLC 控制器
  "scada",        // device.scada.* — SCADA 系统
  "conveyor",     // device.conveyor.* — 传送带控制

  // 机器人
  "robot",        // device.robot.* — 机器人控制
  "arm",          // device.arm.* — 机械臂
  "sensor",       // device.sensor.* — 传感器

  // 智慧园区
  "gate",         // device.gate.* — 闸机/门禁
  "camera",       // device.camera.* — 摄像头
  "elevator",     // device.elevator.* — 电梯
  "light",        // device.light.* — 灯光

  // 汽车
  "vehicle",      // device.vehicle.* — 车载系统
  "can",          // device.can.* — CAN 总线
  "obd",          // device.obd.* — OBD 诊断

  // 智能家居
  "home",         // device.home.* — 智能家居
  "appliance",    // device.appliance.* — 家电控制

  // 对话引擎
  "dialogEngine", // device.dialog.* — 对话引擎（语音对话/意图识别）

  // 蓝牙
  "bluetooth",    // device.bluetooth.* — 蓝牙通信

  // 城市
  "traffic",      // device.traffic.* — 交通控制
  "environment",  // device.environment.* — 环境监测
  "energy",       // device.energy.* — 能源管理

  // 本地 Skill 运行时
  "localSkill",  // device.localSkill.* — 本地 Skill 运行时（子进程隔离执行）
] as const;

export type PluginDomain = (typeof PLUGIN_DOMAINS)[number];

// ── 当前代码库中已实现的插件文件映射 ─────────────────────────

export const CURRENT_PLUGIN_FILES: Record<string, {
  file: string;
  domain: PluginDomain;
  layer: "plugin";
  description: string;
}> = {
  builtinToolPlugin: {
    file: "plugins/builtinToolPlugin.ts",
    domain: "builtin",
    layer: "plugin",
    description: "内置工具（noop/echo）",
  },
  filePlugin: {
    file: "plugins/filePlugin.ts",
    domain: "desktop",
    layer: "plugin",
    description: "本地文件系统能力",
  },
  browserPlugin: {
    file: "plugins/browserPlugin.ts",
    domain: "browser",
    layer: "plugin",
    description: "本地浏览器控制与会话能力",
  },
  desktopControlPlugin: {
    file: "plugins/desktopControlPlugin.ts",
    domain: "desktop",
    layer: "plugin",
    description: "本地桌面控制与窗口交互能力",
  },
  clipboardPlugin: {
    file: "plugins/clipboardPlugin.ts",
    domain: "clipboard",
    layer: "plugin",
    description: "本地剪贴板读写能力",
  },
  evidencePlugin: {
    file: "plugins/evidencePlugin.ts",
    domain: "desktop",
    layer: "plugin",
    description: "端侧证据上传能力",
  },
  guiAutomationPlugin: {
    file: "plugins/guiAutomationPlugin.ts",
    domain: "gui",
    layer: "plugin",
    description: "GUI 自动化：本地视觉闭环（Local Vision Loop）",
  },
  desktopPluginLegacy: {
    file: "plugins/desktopPlugin.ts",
    domain: "desktop",
    layer: "plugin",
    description: "桌面兼容聚合层（仅兼容旧调用）",
  },
  localVision: {
    file: "plugins/localVision.ts",
    domain: "vision",
    layer: "plugin",
    description: "本地视觉底层原语：截图/OCR/鼠标键盘",
  },
  perceptionRouter: {
    file: "plugins/perceptionRouter.ts",
    domain: "perception",
    layer: "plugin",
    description: "感知路由引擎（Playwright + OCR 回退）",
  },
  streamingExecutor: {
    file: "streamingExecutor.ts",
    domain: "streaming",
    layer: "plugin",
    description: "流式控制本地闭环执行器",
  },
  audioPlugin: {
    file: "plugins/audioPlugin.ts",
    domain: "sensor",
    layer: "plugin",
    description: "音频采集与播放能力",
  },
  cameraPlugin: {
    file: "plugins/cameraPlugin.ts",
    domain: "camera",
    layer: "plugin",
    description: "摄像头采集与视频流能力",
  },
  sensorBridgePlugin: {
    file: "plugins/sensorBridgePlugin.ts",
    domain: "sensor",
    layer: "plugin",
    description: "传感器桥接（串口/网络传感器数据采集）",
  },
  localInputPlugin: {
    file: "plugins/localInputPlugin.ts",
    domain: "desktop",
    layer: "plugin",
    description: "本地输入采集（键盘/鼠标/触摸/stdin）",
  },
  dialogEnginePlugin: {
    file: "plugins/dialogEnginePlugin.ts",
    domain: "dialogEngine",
    layer: "plugin",
    description: "对话引擎（语音对话/意图识别）",
  },
  bluetoothPlugin: {
    file: "plugins/bluetoothPlugin.ts",
    domain: "bluetooth",
    layer: "plugin",
    description: "蓝牙通信能力",
  },
};

function resolveDeclaredPluginFile(baseDir: string, relativeFile: string): string {
  const direct = path.join(baseDir, relativeFile);
  if (fs.existsSync(direct)) return direct;
  return path.join(baseDir, relativeFile.replace(/\.ts$/i, ".js"));
}

export function validatePluginBoundary(baseDir = path.resolve(__dirname, "..")): BoundaryValidationIssue[] {
  const issues: BoundaryValidationIssue[] = [];
  for (const entry of Object.values(CURRENT_PLUGIN_FILES)) {
    if (!PLUGIN_DOMAINS.includes(entry.domain)) {
      issues.push({ scope: "plugin", code: "unknown_plugin_domain", detail: `${entry.domain}:${entry.file}` });
    }
    const resolved = resolveDeclaredPluginFile(baseDir, entry.file);
    if (!fs.existsSync(resolved)) {
      issues.push({ scope: "plugin", code: "missing_plugin_file", detail: entry.file });
    }
  }
  return issues;
}

export function assertPluginBoundary(baseDir = path.resolve(__dirname, "..")): void {
  const issues = validatePluginBoundary(baseDir);
  if (issues.length === 0) return;
  const detail = issues.map((issue) => `${issue.scope}:${issue.code}:${issue.detail}`).join("; ");
  throw new Error(`plugin_boundary_invalid: ${detail}`);
}
