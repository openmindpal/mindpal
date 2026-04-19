/**
 * Worker Skill Registry — registers all skill worker contributions.
 *
 * Manifest-driven: skill entries are loaded from worker-skills-manifest.json.
 * Adding a new worker skill only requires updating the manifest file.
 *
 * Supports explicit enablement control via environment variable:
 *   DISABLED_WORKER_SKILLS: Comma-separated list of skill keys to disable.
 *     - "none" (default): All skills enabled
 *     - "all": All skills disabled
 *     - "media.pipeline,ai.event.reasoning": Specific skills disabled
 */
import { registerWorkerContribution, type WorkerSkillContribution } from "../lib/workerSkillContract";
import { StructuredLogger } from "@openslin/shared";
import * as path from "node:path";

import manifestEntries from "./worker-skills-manifest.json";

const _logger = new StructuredLogger({ module: "worker:skillRegistry" });

// ────────────────────────────────────────────────────────────────
// Skill Tier Classification (derived from manifest)
// ────────────────────────────────────────────────────────────────

/** 核心 Worker 能力 — 始终注册，不可禁用 */
export const CORE_WORKER_SKILL_KEYS = manifestEntries
  .filter(e => e.tier === "core")
  .map(e => e.key) as unknown as readonly string[];

/** 可选 Worker 能力 — 默认启用，可通过 DISABLED_WORKER_SKILLS 禁用 */
export const OPTIONAL_WORKER_SKILL_KEYS = manifestEntries
  .filter(e => e.tier === "optional")
  .map(e => e.key) as unknown as readonly string[];

export type WorkerSkillKey = string;

// ────────────────────────────────────────────────────────────────
// Configuration Parsing
// ────────────────────────────────────────────────────────────────

/**
 * 解析禁用的 Worker Skill 列表。
 * 格式: 逗号分隔的 skill key，如 "media.pipeline,ai.event.reasoning"
 * 特殊值: "none" = 全部启用（默认），"all" = 禁用所有可选项
 */
function parseDisabledWorkerSkills(env?: Record<string, string | undefined>): Set<string> {
  const raw = String((env ?? process.env).DISABLED_WORKER_SKILLS ?? "").trim();
  if (!raw || raw === "none") return new Set();
  if (raw === "all") return new Set(OPTIONAL_WORKER_SKILL_KEYS);
  return new Set(raw.split(/[;,]/g).map((s) => s.trim()).filter(Boolean));
}

// ────────────────────────────────────────────────────────────────
// Skill Registration
// ────────────────────────────────────────────────────────────────

export interface WorkerSkillRegistrationResult {
  registered: string[];
  skipped: string[];
  coreCount: number;
  optionalCount: number;
}

/**
 * 从 manifest 加载 worker skill 贡献模块。
 */
function loadWorkerContribution(entry: typeof manifestEntries[number]): WorkerSkillContribution | null {
  try {
    const resolved = path.resolve(__dirname, entry.module);
    const mod = require(resolved);
    return mod[entry.exportName] ?? mod.default ?? mod;
  } catch (err) {
    _logger.warn("[WorkerSkillRegistry] Failed to load skill from manifest", {
      key: entry.key,
      module: entry.module,
      error: String(err),
    });
    return null;
  }
}

/**
 * 初始化 Worker Skill 贡献，支持显式启用控制。
 */
export function initWorkerSkills(env?: Record<string, string | undefined>): WorkerSkillRegistrationResult {
  const disabledSkills = parseDisabledWorkerSkills(env);
  const registered: string[] = [];
  const skipped: string[] = [];
  let coreCount = 0;

  for (const entry of manifestEntries) {
    const isCore = entry.tier === "core";

    // Optional skills can be disabled
    if (!isCore && disabledSkills.has(entry.key)) {
      _logger.info("optional skill skipped", { key: entry.key });
      skipped.push(entry.key);
      continue;
    }

    const contrib = loadWorkerContribution(entry);
    if (!contrib) {
      skipped.push(entry.key);
      continue;
    }

    registerWorkerContribution(contrib);
    registered.push(entry.key);
    if (isCore) coreCount++;
  }

  return {
    registered,
    skipped,
    coreCount,
    optionalCount: registered.length - coreCount,
  };
}
