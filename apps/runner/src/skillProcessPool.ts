/**
 * skillProcessPool.ts — Runner 侧进程池（薄包装）
 *
 * 核心实现已迁移至 @mindpal/shared/skillExecutor，
 * 本文件保留 Runner 专属的单例管理 + childScript 路径解析。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { SkillProcessPool } from "@mindpal/shared";

export { SkillProcessPool } from "@mindpal/shared";

/* ── 解析沙箱子进程入口（Runner 侧 skillSandboxChild） ───── */
let _childEntryCache: { entry: string; execArgv: string[] } | null = null;

async function resolveSandboxChildEntry(): Promise<{ entry: string; execArgv: string[] }> {
  if (_childEntryCache) return _childEntryCache;
  const jsPath = path.resolve(__dirname, "skillSandboxChild.js");
  try {
    const st = await fs.stat(jsPath);
    if (st.isFile()) {
      _childEntryCache = { entry: jsPath, execArgv: [] };
      return _childEntryCache;
    }
  } catch {}
  const tsPath = path.resolve(__dirname, "skillSandboxChild.ts");
  _childEntryCache = { entry: tsPath, execArgv: ["-r", "tsx/cjs"] };
  return _childEntryCache;
}

/* ── 单例 ──────────────────────────────────────────────────── */
let _instance: SkillProcessPool | null = null;

export async function getProcessPool(): Promise<SkillProcessPool> {
  if (!_instance) {
    const childInfo = await resolveSandboxChildEntry();
    _instance = new SkillProcessPool({
      childScriptPath: childInfo.entry,
      childExecArgv: childInfo.execArgv,
    });
  }
  return _instance;
}

export async function shutdownPool(): Promise<void> {
  if (_instance) {
    await _instance.shutdown();
    _instance = null;
  }
}
