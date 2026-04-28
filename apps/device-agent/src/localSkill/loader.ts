/**
 * 本地 Skill 加载器 + DeviceToolPlugin 适配器
 * 扫描本地目录 → 解析 manifest → 包装为标准 DeviceToolPlugin → 注册到内核
 * @layer localSkill
 */
import fs from "node:fs";
import path from "node:path";

import type {
  DeviceToolPlugin,
  CapabilityDescriptor,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@openslin/device-agent-sdk";
import { initPlugin } from "@openslin/device-agent-sdk";
import { resolveDeviceAgentEnv } from "../deviceAgentEnv";
import type { DeviceSkillManifest } from "./manifest";
import { validateManifest, verifyManifestSignature } from "./manifest";
import { executeSkillInProcess } from "./sandbox";

// ── 类型 ──────────────────────────────────────────────────────

export interface SkillEntry {
  manifest: DeviceSkillManifest;
  skillDir: string;
  manifestPath: string;
}

// ── 1. scanSkillDirs ──────────────────────────────────────────

/**
 * 遍历每个 dir 的直接子目录，找到包含 manifest.json 的子目录并解析。
 * 只扫描一层，读取失败的目录 warn 但不阻塞。
 */
export async function scanSkillDirs(dirs: string[]): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];

  for (const dir of dirs) {
    let children: string[];
    try {
      children = await fs.promises.readdir(dir);
    } catch (e: any) {
      console.warn(`[localSkill/loader] cannot read skill dir: ${dir}, ${e?.message ?? e}`);
      continue;
    }

    for (const child of children) {
      const skillDir = path.join(dir, child);

      // 只处理目录
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(skillDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const manifestPath = path.join(skillDir, "manifest.json");
      let raw: unknown;
      try {
        const content = await fs.promises.readFile(manifestPath, "utf-8");
        raw = JSON.parse(content);
      } catch {
        // 无 manifest.json 或解析失败，跳过
        continue;
      }

      entries.push({ manifest: raw as DeviceSkillManifest, skillDir, manifestPath });
    }
  }

  return entries;
}

// ── 2. convertToJsonSchema ────────────────────────────────────

/**
 * 将 manifest 中的简化 io schema 转为标准 JSON Schema 格式。
 */
export function convertToJsonSchema(
  ioSchema: { fields: Record<string, { type: string; required?: boolean }> },
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(ioSchema.fields)) {
    properties[name] = { type: field.type };
    if (field.required) required.push(name);
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ── 3. createPluginFromSkill ──────────────────────────────────

/**
 * 适配器工厂：将本地 Skill manifest 包装为标准 DeviceToolPlugin。
 * @throws 如果 entry 路径越界（逃逸 skillDir）
 */
export function createPluginFromSkill(
  manifest: DeviceSkillManifest,
  skillDir: string,
): DeviceToolPlugin {
  const name = manifest.identity.name;
  const version = manifest.identity.version;

  // entry 路径越界检查
  const entryPath = path.resolve(skillDir, manifest.entry);
  const normalizedSkillDir = path.resolve(skillDir) + path.sep;
  if (!entryPath.startsWith(normalizedSkillDir) && entryPath !== path.resolve(skillDir)) {
    throw new Error(`entry path escapes skillDir: ${manifest.entry}`);
  }

  // 构建 CapabilityDescriptor
  const capabilities: CapabilityDescriptor[] = [
    {
      toolRef: name,
      riskLevel: manifest.contract.riskLevel,
      version,
      tags: manifest.tags ?? [],
      description:
        manifest.description?.["zh-CN"] ??
        manifest.description?.["en-US"] ??
        "",
      inputSchema: manifest.io?.inputSchema
        ? convertToJsonSchema(manifest.io.inputSchema)
        : undefined,
      outputSchema: manifest.io?.outputSchema
        ? convertToJsonSchema(manifest.io.outputSchema)
        : undefined,
    },
  ];

  const plugin: DeviceToolPlugin = {
    name,
    version,
    toolPrefixes: [name],
    toolNames: [name],
    capabilities,
    source: "external",

    async init() {
      /* noop */
    },

    async healthcheck() {
      return {
        healthy: true,
        details: { type: "localSkill", version },
      };
    },

    async execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      try {
        const result = await executeSkillInProcess({
          entryPath,
          toolRef: ctx.toolName,
          input: ctx.input,
        });

        if (result.ok) {
          return {
            status: "succeeded",
            outputDigest: result.output ?? null,
          };
        }
        return {
          status: "failed",
          errorCategory: result.error?.code ?? "SKILL_ERROR",
          outputDigest: { error: result.error?.message ?? "unknown skill error" },
        };
      } catch (e: any) {
        return {
          status: "failed",
          errorCategory: "SKILL_EXECUTION_EXCEPTION",
          outputDigest: { error: e?.message ?? "unknown" },
        };
      }
    },

    async dispose() {
      /* noop */
    },
  };

  return plugin;
}

// ── 4. loadLocalSkills ────────────────────────────────────────

/**
 * 顶层批量加载：扫描 → 校验 → 签名验证(渐进式) → 创建适配器 → 注册。
 * 单个 Skill 失败不阻塞其他 Skill。
 */
export async function loadLocalSkills(
  dirs: string[],
): Promise<{ loaded: string[]; errors: string[] }> {
  const loaded: string[] = [];
  const errors: string[] = [];

  const entries = await scanSkillDirs(dirs);
  const secretKey = resolveDeviceAgentEnv().secretKey;

  for (const entry of entries) {
    const label = entry.manifestPath;
    try {
      // 1. 校验 manifest 结构
      const validation = validateManifest(entry.manifest);
      if (!validation.valid) {
        const msg = `[localSkill/loader] invalid manifest ${label}: ${validation.errors.join("; ")}`;
        console.warn(msg);
        errors.push(msg);
        continue;
      }

      // 2. 签名验证（渐进式安全）
      if (secretKey) {
        if (entry.manifest.signature) {
          const sig = verifyManifestSignature(entry.manifest, secretKey);
          if (!sig.valid) {
            const msg = `[localSkill/loader] signature failed ${label}: ${sig.reason}`;
            console.error(msg);
            errors.push(msg);
            continue;
          }
        } else {
          console.warn(`[localSkill/loader] no signature in ${label}, skipping verification`);
        }
      }

      // 3. 创建适配器
      const plugin = createPluginFromSkill(entry.manifest, entry.skillDir);

      // 4. 注册到内核
      const initResult = await initPlugin(plugin);
      if (!initResult.success) {
        const msg = `[localSkill/loader] initPlugin failed ${label}: ${initResult.error}`;
        console.error(msg);
        errors.push(msg);
        continue;
      }

      loaded.push(entry.manifest.identity.name);
      console.log(`[localSkill/loader] loaded: ${entry.manifest.identity.name}@${entry.manifest.identity.version}`);
    } catch (e: any) {
      const msg = `[localSkill/loader] error loading ${label}: ${e?.message ?? e}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  console.log(`[localSkill/loader] scan complete: ${loaded.length} loaded, ${errors.length} errors`);
  return { loaded, errors };
}
