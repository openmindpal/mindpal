/**
 * 全局配置 — 解析公共 CLI 选项 + 环境变量 + 配置文件
 */
import type { Command } from "commander";
import type { ApiClientOptions } from "./apiClient";
import type { OutputFormat } from "./output";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface GlobalOptions {
  apiBase: string;
  token: string;
  tenantId: string;
  spaceId: string;
  format: OutputFormat;
}

/** 从配置文件加载默认值 */
function loadConfigFile(): Partial<GlobalOptions> {
  const candidates = [
    resolve(process.cwd(), ".mindpal-admin.json"),
    resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", ".mindpal-admin.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        /* ignore */
      }
    }
  }
  return {};
}

/** 将公共选项注册到根 command 上 */
export function addGlobalOptions(program: Command): void {
  program
    .option("--api-base <url>", "API server base URL", process.env.API_BASE ?? "http://localhost:3001")
    .option("--token <token>", "API bearer token", process.env.API_TOKEN ?? "")
    .option("--tenant-id <id>", "Tenant ID", process.env.TENANT_ID ?? "")
    .option("--space-id <id>", "Space ID", process.env.SPACE_ID ?? "")
    .option("--format <fmt>", "Output format (json|table)", "json");
}

/** 解析全局选项（CLI > 环境变量 > 配置文件） */
export function resolveGlobalOptions(cmd: Command): GlobalOptions {
  const raw = cmd.optsWithGlobals();
  const file = loadConfigFile();
  return {
    apiBase: raw.apiBase || file.apiBase || process.env.API_BASE || "http://localhost:3001",
    token: raw.token || file.token || process.env.API_TOKEN || "",
    tenantId: raw.tenantId || file.tenantId || process.env.TENANT_ID || "",
    spaceId: raw.spaceId || file.spaceId || process.env.SPACE_ID || "",
    format: (raw.format || file.format || "json") as OutputFormat,
  };
}

/** 从 GlobalOptions 构建 ApiClientOptions（自动校验 token） */
export function toApiOpts(g: GlobalOptions): ApiClientOptions {
  if (!g.token) {
    console.error("Error: --token is required (or set API_TOKEN env)");
    process.exit(1);
  }
  return {
    apiBase: g.apiBase,
    token: g.token,
    tenantId: g.tenantId || undefined,
    spaceId: g.spaceId || undefined,
  };
}
