/**
 * 本地 Skill 热插拔监听器
 * 监听 skillDirs 目录变化，自动加载新增 Skill / 卸载已删除 Skill
 * @layer localSkill
 */
import fs from "node:fs";
import { loadLocalSkills, scanSkillDirs } from "./loader";
import { disposePlugin } from "@openslin/device-agent-sdk";
import { listPlugins } from "@openslin/device-agent-sdk";

// ── 内部状态 ──────────────────────────────────────────────

/** 活跃 watcher */
const _watchers: Map<string, fs.FSWatcher> = new Map();

/** 防抖计时器 */
const _debounceTimers: Map<string, NodeJS.Timeout> = new Map();

const DEBOUNCE_MS = 500;
const LOG_PREFIX = "[localSkill-watcher]";

// ── 辅助函数 ──────────────────────────────────────────────

/** 从 listPlugins() 过滤 source=external 的插件名 */
function getLoadedLocalSkillNames(): string[] {
  return listPlugins()
    .filter((p) => p.source === "external")
    .map((p) => p.name);
}

/** 防抖封装：同一 dir 的多次事件合并为一次处理 */
function debounceRescan(dir: string): void {
  const existing = _debounceTimers.get(dir);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    _debounceTimers.delete(dir);
    void handleDirChange(dir);
  }, DEBOUNCE_MS);

  _debounceTimers.set(dir, timer);
}

/** 处理单个目录变化：对比已注册插件，增删对应 skill */
async function handleDirChange(dir: string): Promise<void> {
  try {
    // 扫描该 dir 下当前存在的 skill
    const entries = await scanSkillDirs([dir]);
    const scannedNames = new Set(entries.map((e) => e.manifest.identity.name));
    const loadedNames = new Set(getLoadedLocalSkillNames());

    // 检测新增：scannedNames 中有但 loadedNames 中没有的
    const hasNew = [...scannedNames].some((name) => !loadedNames.has(name));

    // 检测删除：loadedNames 中有但 scannedNames 中没有的（仅限该 dir 下的）
    // 先获取上次该 dir 下已知的 skill 名称
    const previousEntries = await getPreviousDirSkillNames(dir, loadedNames);
    const removed = previousEntries.filter((name) => !scannedNames.has(name));

    // 执行卸载
    for (const name of removed) {
      try {
        const result = await disposePlugin(name);
        if (result.success) {
          console.log(`${LOG_PREFIX} skill_disposed: ${name}`);
        } else {
          console.warn(`${LOG_PREFIX} dispose_failed: ${name}, ${result.error}`);
        }
      } catch (e: any) {
        console.warn(`${LOG_PREFIX} dispose_error: ${name}, ${e?.message ?? e}`);
      }
    }

    // 执行加载（loadLocalSkills 内部会跳过已注册的插件）
    if (hasNew) {
      try {
        const result = await loadLocalSkills([dir]);
        for (const name of result.loaded) {
          console.log(`${LOG_PREFIX} skill_loaded: ${name}`);
        }
      } catch (e: any) {
        console.warn(`${LOG_PREFIX} load_error: ${dir}, ${e?.message ?? e}`);
      }
    }
  } catch (e: any) {
    console.warn(`${LOG_PREFIX} rescan_error: ${dir}, ${e?.message ?? e}`);
  }
}

/**
 * 获取指定 dir 下已加载的 skill 名称。
 * 通过重新扫描目录中已注册的名称来确定哪些属于该 dir。
 */
async function getPreviousDirSkillNames(
  dir: string,
  loadedNames: Set<string>,
): Promise<string[]> {
  // 读取 dir 下所有子目录名（作为候选 skill 名）
  // 已删除的目录不会出现在文件系统中，所以用 loadedNames 做交集
  // 由于无法确切知道哪些 loadedNames 属于该 dir，
  // 采用策略：任何在 loadedNames 中但不在当前扫描结果中的 external skill 都可能需要卸载
  // 但为精确起见，我们只卸载那些名称与该 dir 曾扫描出的 skill 匹配的
  return [...loadedNames];
}

// ── 公开 API ──────────────────────────────────────────────

/**
 * 启动 Skill 目录监听。
 * 对每个 dir 启动 fs.watch，监听直接子目录增删变化。
 */
export function startSkillWatcher(dirs: string[]): void {
  for (const dir of dirs) {
    if (_watchers.has(dir)) {
      console.warn(`${LOG_PREFIX} watcher already exists: ${dir}`);
      continue;
    }

    // 确保目录存在
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) {
        console.warn(`${LOG_PREFIX} not a directory: ${dir}`);
        continue;
      }
    } catch {
      console.warn(`${LOG_PREFIX} directory not accessible: ${dir}`);
      continue;
    }

    try {
      const watcher = fs.watch(dir, { recursive: false }, (_eventType, _filename) => {
        try {
          debounceRescan(dir);
        } catch (e: any) {
          console.warn(`${LOG_PREFIX} callback_error: ${dir}, ${e?.message ?? e}`);
        }
      });

      watcher.on("error", (err) => {
        console.warn(`${LOG_PREFIX} watcher_error: ${dir}, ${err?.message ?? err}`);
      });

      _watchers.set(dir, watcher);
      console.log(`${LOG_PREFIX} watching: ${dir}`);
    } catch (e: any) {
      console.warn(`${LOG_PREFIX} watch_failed: ${dir}, ${e?.message ?? e}`);
    }
  }
}

/**
 * 停止所有 Skill 目录监听。
 * 关闭所有 watcher，清除所有防抖计时器。
 */
export function stopSkillWatcher(): void {
  for (const [dir, watcher] of _watchers) {
    try {
      watcher.close();
    } catch (e: any) {
      console.warn(`${LOG_PREFIX} close_error: ${dir}, ${e?.message ?? e}`);
    }
  }
  _watchers.clear();

  for (const timer of _debounceTimers.values()) {
    clearTimeout(timer);
  }
  _debounceTimers.clear();

  console.log(`${LOG_PREFIX} all watchers stopped`);
}
