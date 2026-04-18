/**
 * 托盘工具本地禁用列表管理模块
 */
import fs from "node:fs";
import path from "node:path";
import { defaultConfigPath, loadConfigFile } from "../config";
import { safeLog, safeError } from "../log";
import { executionStats } from "./stats";

const _localDisabledTools = new Set<string>();
let _highRiskConfirmEnabled = true;

function getLocalDisabledToolsPath(): string {
  return path.join(path.dirname(defaultConfigPath()), "disabled-tools.json");
}

export function loadLocalDisabledTools(): void {
  try {
    const raw = fs.readFileSync(getLocalDisabledToolsPath(), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.disabled)) {
      _localDisabledTools.clear();
      for (const t of data.disabled) {
        if (typeof t === "string") _localDisabledTools.add(t);
      }
    }
    if (typeof data.highRiskConfirmEnabled === "boolean") {
      _highRiskConfirmEnabled = data.highRiskConfirmEnabled;
    }
    safeLog(`[托盘] 加载本地禁用工具列表: ${_localDisabledTools.size} 个工具被禁用, 高风险确认=${_highRiskConfirmEnabled}`);
  } catch {
    // 文件不存在或解析失败，使用默认值
  }
}

export function saveLocalDisabledTools(): void {
  try {
    const dir = path.dirname(getLocalDisabledToolsPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      getLocalDisabledToolsPath(),
      JSON.stringify({ disabled: Array.from(_localDisabledTools), highRiskConfirmEnabled: _highRiskConfirmEnabled }, null, 2),
      "utf8",
    );
    safeLog(`[托盘] 保存本地禁用工具列表: ${_localDisabledTools.size} 个`);
    syncDisabledToolsToCloud().catch(() => {});
  } catch (e: any) {
    safeError(`[托盘] 保存禁用列表失败: ${e?.message}`);
  }
}

async function syncDisabledToolsToCloud(): Promise<void> {
  try {
    const cfg = await loadConfigFile(defaultConfigPath());
    if (!cfg?.deviceToken || !cfg?.apiBase) return;
    const { apiPostJson } = await import("../api");
    await apiPostJson({
      apiBase: cfg.apiBase,
      path: "/device-agent/sync-disabled-tools",
      token: cfg.deviceToken,
      body: {
        disabledTools: Array.from(_localDisabledTools),
        highRiskConfirmEnabled: _highRiskConfirmEnabled,
        stats: { ...executionStats },
      },
    });
    safeLog(`[托盘] 本地禁用列表已同步到云端 (${_localDisabledTools.size} 个)`);
  } catch (e: any) {
    safeError(`[托盘] 云端同步失败: ${e?.message}`);
  }
}

export function isToolLocallyDisabled(toolRef: string): boolean {
  return _localDisabledTools.has(toolRef);
}

export function getLocalDisabledTools(): Set<string> {
  return _localDisabledTools;
}

export function isHighRiskConfirmEnabled(): boolean {
  return _highRiskConfirmEnabled;
}

export function setHighRiskConfirmEnabled(enabled: boolean): void {
  _highRiskConfirmEnabled = enabled;
}
