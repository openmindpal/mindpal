import SysTray from "systray2";
import { loadConfigFile, defaultConfigPath } from "./config";
import { runLoop } from "./agent";
import { safeLog, safeError } from "./log";
import { loadLocalDisabledTools, isToolLocallyDisabled } from "./tray/disableList";
import { showDesktopNotification, openDirectory } from "./tray/notifications";
import { getAuditDir } from "./kernel/audit";
import { buildMenu, getToolRiskSummary, getPluginStatusSummary, type TrayState, type PendingConfirmation } from "./trayMenuBuilder";
import { handleViewToolDetails, handleToggleHighRiskConfirm, handleDisableHighRiskTools, handleEnableAllTools, trayConfirmFn } from "./trayToolHandlers";
import { isHighRiskConfirmEnabled } from "./tray/disableList";
import { onTrayStateChange } from "./trayState";

export { isToolLocallyDisabled };

interface TrayContext {
  systray: SysTray | null;
  state: TrayState;
  stopFn: (() => void) | null;
  pendingConfirmation: PendingConfirmation | null;
  lastHeartbeat: string | null;
  pendingTaskCount: number;
}

const ctx: TrayContext = {
  systray: null,
  state: "idle",
  stopFn: null,
  pendingConfirmation: null,
  lastHeartbeat: null,
  pendingTaskCount: 0,
};

// 菜单构建和工具管理交互已提取到 trayMenuBuilder.ts / trayToolHandlers.ts

async function checkPaired(): Promise<boolean> {
  try {
    const cfg = await loadConfigFile(defaultConfigPath());
    return !!(cfg?.deviceId && cfg?.deviceToken);
  } catch {
    return false;
  }
}

async function handleStartStop() {
  if (ctx.state === "running" && ctx.stopFn) {
    safeLog("[托盘] 用户请求停止运行");
    ctx.stopFn();
    ctx.stopFn = null;
    ctx.state = "paired";
    updateTray();
    return;
  }

  if (ctx.state === "paired") {
    safeLog("[托盘] 用户请求启动运行");
    ctx.state = "running";
    updateTray();

    try {
      const cfg = await loadConfigFile(defaultConfigPath());
      if (!cfg) throw new Error("配置文件不存在");

      let shouldStop = false;
      ctx.stopFn = () => { shouldStop = true; };

      const origHeartbeatMs = 30000;
      const heartbeatTracker = setInterval(() => {
        ctx.lastHeartbeat = new Date().toISOString();
      }, origHeartbeatMs);

      const result = await runLoop({
        cfg,
        confirmFn: (question: string) => trayConfirmFn(question, ctx, updateTray),
        heartbeatIntervalMs: origHeartbeatMs,
        pollIntervalMs: 5000,
        idleTimeoutMs: 0,
        shouldStopFn: () => shouldStop,
      });

      clearInterval(heartbeatTracker);
      safeLog(`[托盘] 运行结束: ${result.stopReason}`);
    } catch (e: any) {
      safeError(`[托盘] 运行错误: ${e?.message}`);
      ctx.state = "error";
    }

    ctx.state = "paired";
    ctx.stopFn = null;
    updateTray();
  }
}

/**
 * trayConfirmFn 已提取到 trayToolHandlers.ts，
 * handleViewToolDetails / handleToggleHighRiskConfirm / handleDisableHighRiskTools / handleEnableAllTools 同样。
 */

async function handlePair() {
  safeLog("[托盘] 用户请求配对 - 请在命令行执行: openslin-device-agent pair --pairingCode <code>");
  showDesktopNotification("需要配对", "请在命令行执行: openslin-device-agent pair --pairingCode <配对码>");
}

function handleViewLog() {
  const logPath = process.cwd();
  safeLog(`[托盘] 日志目录: ${logPath}`);
  openDirectory(logPath);
}

function handleViewAuditLog() {
  const auditDir = getAuditDir();
  safeLog(`[托盘] 审计日志目录: ${auditDir}`);
  openDirectory(auditDir);
}

function handleOpenConfig() {
  const cfgPath = defaultConfigPath();
  const cfgDir = cfgPath.replace(/[/\\][^/\\]+$/, "");
  safeLog(`[托盘] 配置目录: ${cfgDir}`);
  openDirectory(cfgDir);
}

function handleConfirmExecution(confirmed: boolean) {
  if (!ctx.pendingConfirmation) return;
  const toolRef = ctx.pendingConfirmation.toolRef;
  safeLog(`[托盘] 用户通过菜单${confirmed ? "确认" : "拒绝"}执行: ${toolRef}`);
  ctx.pendingConfirmation.resolve(confirmed);
  ctx.pendingConfirmation = null;
  updateTray();
}

function handleExit() {
  safeLog("[托盘] 用户请求退出");
  if (ctx.stopFn) ctx.stopFn();
  ctx.systray?.kill(false);
  process.exit(0);
}

function updateTray() {
  if (!ctx.systray) return;
  const menu = buildMenu(ctx.state, { pendingConfirmation: ctx.pendingConfirmation, lastHeartbeat: ctx.lastHeartbeat });
  ctx.systray.kill(false);
  startTrayWithMenu(menu);
}

function startTrayWithMenu(menu: ReturnType<typeof buildMenu>) {
  ctx.systray = new SysTray({ menu, copyDir: false });

  ctx.systray.onClick((action) => {
    const title = action.item.title;
    // 确认交互
    if (title.includes("确认执行")) {
      handleConfirmExecution(true);
    } else if (title.includes("拒绝执行")) {
      handleConfirmExecution(false);
    }
    // 运行控制
    else if (title.includes("启动运行") || title.includes("停止运行")) {
      handleStartStop();
    } else if (title.includes("重新配对")) {
      handlePair();
    }
    // 工具管理
    else if (title.includes("查看工具详情")) {
      handleViewToolDetails();
    } else if (title.includes("高风险确认")) {
      handleToggleHighRiskConfirm(updateTray);
    } else if (title.includes("禁用高风险工具")) {
      handleDisableHighRiskTools(updateTray);
    } else if (title.includes("解除所有本地禁用")) {
      handleEnableAllTools(updateTray);
    }
    // 诊断
    else if (title.includes("查看审计日志")) {
      handleViewAuditLog();
    } else if (title.includes("查看日志")) {
      handleViewLog();
    } else if (title.includes("打开配置目录")) {
      handleOpenConfig();
    } else if (title.includes("退出")) {
      handleExit();
    }
  });
}

export async function startTray() {
  safeLog("[托盘] 启动托盘模式...");

  // 加载本地禁用工具列表
  loadLocalDisabledTools();

  // 检查是否已配对
  const paired = await checkPaired();
  ctx.state = paired ? "paired" : "idle";

  const riskSummary = getToolRiskSummary();
  const pluginSummary = getPluginStatusSummary();

  const menu = buildMenu(ctx.state, { pendingConfirmation: ctx.pendingConfirmation, lastHeartbeat: ctx.lastHeartbeat });
  startTrayWithMenu(menu);

  safeLog(`[托盘] 托盘已启动，当前状态: ${ctx.state}`);
  safeLog(`[托盘] 工具概况: ${riskSummary.total}个工具 (低${riskSummary.low}/中${riskSummary.medium}/高${riskSummary.high}/危${riskSummary.critical}) 禁用${riskSummary.disabled}个`);
  safeLog(`[托盘] 插件概况: ${pluginSummary.total}个 (${pluginSummary.ready}就绪/${pluginSummary.error}错误)`);
  safeLog(`[托盘] 高风险确认: ${isHighRiskConfirmEnabled() ? "开启" : "关闭"}`);
  safeLog("[托盘] 右键点击托盘图标查看菜单");

  // 事件驱动更新：能力/插件状态变化时自动刷新托盘菜单
  onTrayStateChange(() => {
    if (ctx.state === "running") updateTray();
  });

  // 保底刷新：防止事件丢失导致菜单永不更新（5分钟）
  setInterval(() => {
    if (ctx.state === "running") updateTray();
  }, 300_000);

  // 已配对时自动启动运行，无需用户手动点击
  if (ctx.state === "paired") {
    safeLog("[托盘] 自动启动运行...");
    setTimeout(() => handleStartStop(), 2000);
  }
}
