/**
 * trayToolHandlers.ts — 托盘工具管理交互处理
 *
 * 从 tray.ts 提取，负责：
 * - 工具详情弹窗 (handleViewToolDetails)
 * - 高风险确认开关 (handleToggleHighRiskConfirm)
 * - 批量禁用/解禁工具 (handleDisableHighRiskTools, handleEnableAllTools)
 * - trayConfirmFn（智能确认函数）
 */
import { getCachedCapabilities, getCachedPluginStates } from "./trayState";
import type { RiskLevel } from "./kernel/types";
import { executionStats, recordExecution } from "./tray/stats";
import {
  isToolLocallyDisabled, getLocalDisabledTools,
  saveLocalDisabledTools, isHighRiskConfirmEnabled, setHighRiskConfirmEnabled,
} from "./tray/disableList";
import { showDesktopNotification, showConfirmDialog } from "./tray/notifications";
import { safeLog } from "./log";
import { formatTimeDelta, type PendingConfirmation } from "./trayMenuBuilder";

/* ── 工具详情弹窗 ────────────────────────────────────────── */

export function handleViewToolDetails() {
  const caps = getCachedCapabilities();
  const pluginStates = getCachedPluginStates();
  const isWin = process.platform === "win32";
  const riskIcons: Record<RiskLevel, string> = isWin
    ? { low: "[低]", medium: "[中]", high: "[高]", critical: "[危]" }
    : { low: "🟢", medium: "🟡", high: "🔴", critical: "⚫" };
  const sep = isWin ? "==========================================" : "═══════════════════════════════════════════";

  const lines: string[] = [sep, "  灵智Mindpal 端侧工具清单", sep, ""];

  if (pluginStates.length === 0) {
    lines.push("  (当前无已加载插件，工具列表为空)");
    lines.push("  提示: 设置 DEVICE_AGENT_BUILTIN_PLUGINS=desktop 可启用桌面工具");
    lines.push("");
  }

  for (const ps of pluginStates) {
    const stateIcon = ps.state === "ready" ? (isWin ? "[OK]" : "✅") : ps.state === "error" ? (isWin ? "[ERR]" : "❌") : (isWin ? "[...]" : "⏳");
    lines.push(`${stateIcon} 插件: ${ps.name} [${ps.state}] 前缀: ${ps.toolPrefixes.join(", ")}`);
    if (ps.error) lines.push(`   ${isWin ? "[!]" : "⚠️"} 错误: ${ps.error}`);

    const pluginCaps = caps.filter((c) => ps.toolPrefixes.some((prefix) => c.toolRef === prefix || c.toolRef.startsWith(prefix + ".")));
    for (const cap of pluginCaps) {
      const disabled = getLocalDisabledTools().has(cap.toolRef) ? (isWin ? " [禁用]" : " 🚫禁用") : "";
      const risk = riskIcons[cap.riskLevel] ?? (isWin ? "[?]" : "⚪");
      lines.push(`   ${risk} ${cap.toolRef} (${cap.riskLevel})${disabled}${cap.description ? " - " + cap.description : ""}`);
    }
    lines.push("");
  }

  if (executionStats.totalExecuted > 0) {
    lines.push(isWin ? "-- 执行统计 --" : "── 执行统计 ──");
    lines.push(`   总计: ${executionStats.totalExecuted} | 成功: ${executionStats.succeeded} | 失败: ${executionStats.failed} | 拒绝: ${executionStats.denied}`);
    lines.push(`   用户确认: ${executionStats.confirmedByUser} | 自动确认: ${executionStats.autoConfirmed}`);
    if (executionStats.lastToolRef) {
      lines.push(`   最近工具: ${executionStats.lastToolRef} (${executionStats.lastExecutionTime ? formatTimeDelta(executionStats.lastExecutionTime) : "未知"})`);
    }
  }

  const report = lines.join("\n");
  safeLog(`[托盘] 工具详情:\n${report}`);

  import("child_process").then(({ exec }) => {
    if (process.platform === "win32") {
      const escaped = report
        .replace(/`/g, "``")
        .replace(/\$/g, "`$")
        .replace(/"/g, '`"')
        .replace(/\n/g, "`n");
      const psScript = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show("${escaped}", "灵智Mindpal - 工具详情", "OK", "Information")`;
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      exec(`powershell -EncodedCommand ${encoded}`);
    } else if (process.platform === "darwin") {
      exec(`osascript -e 'display dialog "${report.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" with title "灵智Mindpal - 工具详情" buttons {"关闭"} default button "关闭"'`);
    } else {
      exec(`zenity --info --title="灵智Mindpal - 工具详情" --text="${report.replace(/"/g, '\\"')}" --width=600`);
    }
  });
}

/* ── 工具管理操作 ────────────────────────────────────────── */

export function handleToggleHighRiskConfirm(updateTray: () => void) {
  setHighRiskConfirmEnabled(!isHighRiskConfirmEnabled());
  saveLocalDisabledTools();
  safeLog(`[托盘] 高风险确认${isHighRiskConfirmEnabled() ? "已开启" : "已关闭"}`);
  showDesktopNotification("设置已更新", `高风险工具执行确认: ${isHighRiskConfirmEnabled() ? "已开启" : "已关闭"}`);
  updateTray();
}

export function handleDisableHighRiskTools(updateTray: () => void) {
  const highRisk = getCachedCapabilities().filter((c) => c.riskLevel === "high" || c.riskLevel === "critical");
  const disabledSet = getLocalDisabledTools();
  let added = 0;
  for (const cap of highRisk) {
    if (!disabledSet.has(cap.toolRef)) {
      disabledSet.add(cap.toolRef);
      added++;
    }
  }
  saveLocalDisabledTools();
  safeLog(`[托盘] 禁用高风险工具: 新增${added}个，总禁用${disabledSet.size}个`);
  showDesktopNotification("高风险工具已禁用", `已禁用 ${disabledSet.size} 个高/危风险工具`);
  updateTray();
}

export function handleEnableAllTools(updateTray: () => void) {
  const disabledSet = getLocalDisabledTools();
  const count = disabledSet.size;
  disabledSet.clear();
  saveLocalDisabledTools();
  safeLog(`[托盘] 解除所有本地禁用: 恢复${count}个工具`);
  showDesktopNotification("工具已恢复", `已恢复 ${count} 个被禁用的工具`);
  updateTray();
}

/* ── 智能确认函数 ────────────────────────────────────────── */

/**
 * 托盘模式智能确认函数：
 * - 低风险工具：自动确认
 * - 中风险工具：通知后自动确认
 * - 高/危风险工具：弹窗等待用户确认
 * - 本地禁用的工具：直接拒绝
 */
export async function trayConfirmFn(
  question: string,
  ctx: { pendingConfirmation: PendingConfirmation | null },
  updateTray: () => void,
): Promise<boolean> {
  const toolRefMatch = question.match(/(?:执行|execute|run|confirm)\s*["']?([\w.@]+)["']?/i);
  const toolRef = toolRefMatch?.[1] ?? "unknown";

  if (isToolLocallyDisabled(toolRef)) {
    safeLog(`[托盘] 工具被本地禁用，拒绝执行: ${toolRef}`);
    showDesktopNotification("工具执行被拒绝", `${toolRef} 已被本地禁用`);
    recordExecution(toolRef, "denied", false);
    return false;
  }

  const caps = getCachedCapabilities();
  const cap = caps.find((c) => c.toolRef === toolRef);
  const riskLevel: RiskLevel = cap?.riskLevel ?? "medium";

  if (isHighRiskConfirmEnabled() && (riskLevel === "high" || riskLevel === "critical")) {
    safeLog(`[托盘] 高风险工具需要用户确认: ${toolRef} (${riskLevel})`);
    showDesktopNotification("⚠️ 需要确认", `高风险工具 ${toolRef} 请求执行，请在弹窗中确认`);

    const confirmed = await new Promise<boolean>((resolve) => {
      ctx.pendingConfirmation = { toolRef, question, resolve, createdAt: Date.now() };
      updateTray();

      showConfirmDialog(
        "灵智Mindpal - 工具执行确认",
        `⚠️ 高风险操作

工具: ${toolRef}
风险等级: ${riskLevel}

${question}

确认执行此操作？`,
      ).then((result) => {
        if (ctx.pendingConfirmation?.toolRef === toolRef) {
          ctx.pendingConfirmation = null;
          resolve(result);
          updateTray();
        }
      });

      setTimeout(() => {
        if (ctx.pendingConfirmation?.toolRef === toolRef) {
          safeLog(`[托盘] 确认超时，自动拒绝: ${toolRef}`);
          ctx.pendingConfirmation = null;
          resolve(false);
          updateTray();
        }
      }, 30000);
    });

    recordExecution(toolRef, confirmed ? "succeeded" : "denied", true);
    safeLog(`[托盘] 用户确认结果: ${toolRef} → ${confirmed ? "确认" : "拒绝"}`);
    return confirmed;
  }

  if (riskLevel === "medium") {
    showDesktopNotification("工具执行中", `${toolRef} (风险:${riskLevel})`);
    safeLog(`[托盘] 中风险工具通知后自动确认: ${toolRef}`);
    recordExecution(toolRef, "succeeded", false);
    return true;
  }

  safeLog(`[托盘] 低风险工具自动确认: ${toolRef}`);
  recordExecution(toolRef, "succeeded", false);
  return true;
}
