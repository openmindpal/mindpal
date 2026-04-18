/**
 * trayMenuBuilder.ts — 托盘菜单构建与辅助函数
 *
 * 从 tray.ts 提取，负责：
 * - 系统托盘图标加载
 * - 工具风险/插件状态摘要
 * - 动态菜单构建
 */
import SysTray from "systray2";
import fs from "node:fs";
import path from "node:path";
import { listPlugins } from "./pluginRegistry";
import { listCapabilities } from "./kernel/capabilityRegistry";
import { listPluginStates } from "./kernel/pluginLifecycle";
import { executionStats } from "./tray/stats";
import { getLocalDisabledTools, isHighRiskConfirmEnabled } from "./tray/disableList";
import type { RiskLevel } from "./kernel/types";

/* ── 图标加载 ─────────────────────────────────────────────────── */

const FALLBACK_ICON =
  "AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAAAABMLAAATCwAAAAAAAAAAAAD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////ACAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/yAgIP8gICD/ICAg/////wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

let cachedIcon: string | null | undefined;

function resolveIconPath() {
  const candidates = [
    path.resolve(__dirname, "..", "icon.ico"),
    path.resolve(process.cwd(), "icon.ico"),
    path.resolve(process.cwd(), "apps", "device-agent", "icon.ico"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

export function loadIcon(): string {
  if (cachedIcon !== undefined) return cachedIcon ?? FALLBACK_ICON;
  const iconPath = resolveIconPath();
  cachedIcon = iconPath;
  return iconPath ?? FALLBACK_ICON;
}

/* ── 辅助摘要函数 ───────────────────────────────────────────── */

export function getToolRiskSummary(): { low: number; medium: number; high: number; critical: number; total: number; disabled: number } {
  const caps = listCapabilities();
  const disabled = getLocalDisabledTools().size;
  const summary = { low: 0, medium: 0, high: 0, critical: 0, total: caps.length, disabled };
  for (const cap of caps) {
    const level = cap.riskLevel as keyof typeof summary;
    if (level in summary && typeof summary[level] === "number") {
      (summary as any)[level]++;
    }
  }
  return summary;
}

export function getPluginStatusSummary(): { total: number; ready: number; error: number; details: string } {
  const states = listPluginStates();
  const ready = states.filter((s) => s.state === "ready").length;
  const error = states.filter((s) => s.state === "error").length;
  const details = states.map((s) => {
    const icon = s.state === "ready" ? "✅" : s.state === "error" ? "❌" : "⏳";
    return `${icon} ${s.name} [${s.state}]`;
  }).join("\n");
  return { total: states.length, ready, error, details };
}

export function formatTimeDelta(isoStr: string): string {
  const delta = Date.now() - new Date(isoStr).getTime();
  if (delta < 60_000) return `${Math.round(delta / 1000)}秒前`;
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}分钟前`;
  if (delta < 86400_000) return `${Math.round(delta / 3600_000)}小时前`;
  return `${Math.round(delta / 86400_000)}天前`;
}

/* ── 菜单构建 ─────────────────────────────────────────────── */

export type TrayState = "idle" | "paired" | "running" | "error";

export interface PendingConfirmation {
  toolRef: string;
  question: string;
  resolve: (confirmed: boolean) => void;
  createdAt: number;
}

export function buildMenu(
  state: TrayState,
  opts: { pendingConfirmation: PendingConfirmation | null; lastHeartbeat: string | null },
) {
  const statusIcon = { idle: "⚪", paired: "🟡", running: "🟢", error: "🔴" }[state];
  const statusText = {
    idle: "状态：未配对",
    paired: "状态：已配对（未运行）",
    running: "状态：运行中",
    error: "状态：错误",
  }[state];

  const plugins = listPlugins();
  const toolCount = plugins.reduce((sum, p) => sum + (p.toolNames?.length ?? 0), 0);
  const riskSummary = getToolRiskSummary();
  const pluginSummary = getPluginStatusSummary();

  // 动态 tooltip
  const tooltipParts = [`灵智Mindpal设备代理`, statusText];
  if (state === "running") {
    tooltipParts.push(`工具: ${toolCount}个 | 插件: ${pluginSummary.ready}/${pluginSummary.total}就绪`);
    if (executionStats.totalExecuted > 0) {
      tooltipParts.push(`执行: ${executionStats.succeeded}成功 ${executionStats.failed}失败 ${executionStats.denied}拒绝`);
    }
    if (opts.lastHeartbeat) {
      tooltipParts.push(`心跳: ${formatTimeDelta(opts.lastHeartbeat)}`);
    }
  }

  const hasPending = opts.pendingConfirmation !== null;

  const items: any[] = [
    { title: `${statusIcon} ${statusText}`, tooltip: tooltipParts.join(" | "), enabled: false },
  ];

  // ── 待确认工具弹窗入口 ──
  if (hasPending) {
    items.push({
      title: `🔔 待确认: ${opts.pendingConfirmation!.toolRef}`,
      tooltip: opts.pendingConfirmation!.question,
      enabled: true,
    });
    items.push({ title: "   ✅ 确认执行", tooltip: "确认执行此工具", enabled: true });
    items.push({ title: "   ❌ 拒绝执行", tooltip: "拒绝执行此工具", enabled: true });
    items.push(SysTray.separator);
  }

  // ── 工具管理区域 ──
  items.push(SysTray.separator);
  items.push({
    title: `🛠️ 工具总览: ${toolCount}个工具 (${pluginSummary.ready}个插件就绪)`,
    tooltip: pluginSummary.details,
    enabled: false,
  });
  items.push({
    title: `   🟢低${riskSummary.low} 🟡中${riskSummary.medium} 🔴高${riskSummary.high} ⚫危${riskSummary.critical}${riskSummary.disabled > 0 ? ` | 🚫禁用${riskSummary.disabled}` : ""}`,
    tooltip: "工具风险等级分布",
    enabled: false,
  });

  if (state === "running" && executionStats.totalExecuted > 0) {
    const lastInfo = executionStats.lastToolRef
      ? ` | 最近: ${executionStats.lastToolRef}` : "";
    items.push({
      title: `   📊 执行统计: ✅${executionStats.succeeded} ❌${executionStats.failed} 🚫${executionStats.denied}${lastInfo}`,
      tooltip: `总执行${executionStats.totalExecuted}次 | 用户确认${executionStats.confirmedByUser} | 自动确认${executionStats.autoConfirmed}`,
      enabled: false,
    });
  }

  // ── 工具管理操作 ──
  items.push(SysTray.separator);
  items.push({ title: "📋 查看工具详情", tooltip: "显示所有已注册工具及其风险等级", enabled: true });
  items.push({
    title: `🛡️ 高风险确认: ${isHighRiskConfirmEnabled() ? "已开启 ✅" : "已关闭 ⚠️"}`,
    tooltip: isHighRiskConfirmEnabled() ? "点击关闭高风险工具执行前确认" : "点击开启高风险工具执行前确认",
    enabled: true,
  });
  items.push({
    title: `🚫 禁用高风险工具${getLocalDisabledTools().size > 0 ? " (已禁用" + getLocalDisabledTools().size + "个)" : ""}`,
    tooltip: "一键禁用所有 high/critical 风险等级工具",
    enabled: true,
  });
  items.push({
    title: "✅ 解除所有本地禁用",
    tooltip: "恢复所有被本地禁用的工具",
    enabled: getLocalDisabledTools().size > 0,
  });

  // ── 运行控制 ──
  items.push(SysTray.separator);
  items.push({
    title: state === "running" ? "⏹️ 停止运行" : "▶️ 启动运行",
    tooltip: state === "running" ? "停止后台任务轮询" : "开始后台任务轮询",
    enabled: state === "paired" || state === "running",
  });
  items.push({ title: "🔗 重新配对", tooltip: "在命令行执行配对", enabled: state !== "running" });

  // ── 诊断工具 ──
  items.push(SysTray.separator);
  items.push({ title: "📋 查看日志", tooltip: "打开日志目录", enabled: true });
  items.push({ title: "📊 查看审计日志", tooltip: "打开审计日志目录", enabled: true });
  items.push({ title: "⚙️ 打开配置目录", tooltip: "打开配置文件所在目录", enabled: true });
  items.push(SysTray.separator);
  items.push({ title: "❌ 退出", tooltip: "关闭设备代理", enabled: true });

  return {
    icon: loadIcon(),
    title: "",
    tooltip: tooltipParts.join(" | "),
    items,
  };
}
