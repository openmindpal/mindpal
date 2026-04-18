/**
 * P3-02: API 版本化过渡中间件
 *
 * 功能：
 * - 自动为无前缀路由添加 Deprecation / Sunset Header
 * - 版本协商：Accept-Version header 或 URL 前缀 (/v1/, /v2/)
 * - 日落计划：配置 sunset 日期后自动响应 410 Gone
 * - 记录旧版本调用量指标
 * - 不兼容检测：标记 breaking change 路由
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiVersionStatus = "current" | "deprecated" | "sunset";

export interface ApiVersionConfig {
  /** 版本号，如 "v1", "v2" */
  version: string;
  /** 状态 */
  status: ApiVersionStatus;
  /** 废弃日期（ISO 8601），仅 deprecated 状态需要 */
  deprecatedAt?: string;
  /** 日落日期（ISO 8601），到期后返回 410 Gone */
  sunsetDate?: string;
  /** 替代版本提示，如 "v2" */
  successorVersion?: string;
  /** 日落后的消息 */
  sunsetMessage?: string;
}

export interface RouteVersionOverride {
  /** 路由路径前缀（如 "/entities", "/runs"） */
  pathPrefix: string;
  /** 该路由的版本状态覆盖 */
  status: ApiVersionStatus;
  /** 日落日期 */
  sunsetDate?: string;
  /** 替代端点 */
  successorEndpoint?: string;
  /** 不兼容说明 */
  breakingChangeNote?: string;
}

// ---------------------------------------------------------------------------
// 默认版本配置
// ---------------------------------------------------------------------------

const DEFAULT_VERSIONS: ApiVersionConfig[] = [
  {
    version: "v1",
    status: "current",
  },
];

// 可通过 governance 配置的路由级废弃覆盖
const ROUTE_OVERRIDES: RouteVersionOverride[] = [];

// ---------------------------------------------------------------------------
// 版本指标统计
// ---------------------------------------------------------------------------

const versionCallCounts = new Map<string, number>();

/** 获取版本调用统计（用于 /metrics 或诊断端点） */
export function getApiVersionMetrics(): Array<{ version: string; callCount: number }> {
  const result: Array<{ version: string; callCount: number }> = [];
  for (const [version, count] of versionCallCounts) {
    result.push({ version, callCount: count });
  }
  return result.sort((a, b) => a.version.localeCompare(b.version));
}

/** 重置计数（测试用） */
export function resetApiVersionMetrics(): void {
  versionCallCounts.clear();
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 从 URL 中提取版本前缀 */
function extractVersionFromUrl(url: string): { version: string | null; path: string } {
  const match = url.match(/^\/(v\d+)(\/.*)?$/);
  if (match) {
    return { version: match[1], path: match[2] ?? "/" };
  }
  return { version: null, path: url };
}

/** 从 Accept-Version header 提取版本 */
function extractVersionFromHeader(req: FastifyRequest): string | null {
  const header = req.headers["accept-version"] ?? req.headers["x-api-version"];
  if (typeof header === "string" && header.trim()) {
    return header.trim().toLowerCase();
  }
  return null;
}

/** 查找版本配置 */
function findVersionConfig(version: string, configs: ApiVersionConfig[]): ApiVersionConfig | undefined {
  return configs.find((c) => c.version === version);
}

/** 查找路由级覆盖 */
function findRouteOverride(path: string, overrides: RouteVersionOverride[]): RouteVersionOverride | undefined {
  // 最长前缀匹配
  let best: RouteVersionOverride | undefined;
  for (const o of overrides) {
    if (path.startsWith(o.pathPrefix)) {
      if (!best || o.pathPrefix.length > best.pathPrefix.length) {
        best = o;
      }
    }
  }
  return best;
}

/** 检查日落日期是否已过期 */
function isSunset(sunsetDate: string | undefined): boolean {
  if (!sunsetDate) return false;
  try {
    return new Date(sunsetDate).getTime() <= Date.now();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fastify 插件
// ---------------------------------------------------------------------------

export const apiVersionPlugin: FastifyPluginAsync<{
  /** API 版本配置列表 */
  versions?: ApiVersionConfig[];
  /** 路由级版本覆盖 */
  routeOverrides?: RouteVersionOverride[];
  /** 默认版本（未指定时使用） */
  defaultVersion?: string;
  /** 是否在日落后返回 410 Gone（默认 true） */
  enforceGone?: boolean;
}> = async (app, opts) => {
  const versions = opts.versions ?? DEFAULT_VERSIONS;
  const routeOverrides = [...ROUTE_OVERRIDES, ...(opts.routeOverrides ?? [])];
  const defaultVersion = opts.defaultVersion ?? "v1";
  const enforceGone = opts.enforceGone ?? true;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? req.url;

    // 跳过内部路由
    if (url === "/healthz" || url === "/readyz" || url === "/metrics") return;

    // 1. 解析请求的 API 版本
    const urlParsed = extractVersionFromUrl(url);
    const headerVersion = extractVersionFromHeader(req);
    const effectiveVersion = urlParsed.version ?? headerVersion ?? defaultVersion;
    const effectivePath = urlParsed.path;

    // 记录版本调用计数
    versionCallCounts.set(effectiveVersion, (versionCallCounts.get(effectiveVersion) ?? 0) + 1);

    // 2. 查找版本配置
    const versionCfg = findVersionConfig(effectiveVersion, versions);
    const routeOverride = findRouteOverride(effectivePath, routeOverrides);

    // 合并状态（路由级覆盖优先）
    const status: ApiVersionStatus = routeOverride?.status ?? versionCfg?.status ?? "current";
    const sunsetDate = routeOverride?.sunsetDate ?? versionCfg?.sunsetDate;
    const successorVersion = versionCfg?.successorVersion;
    const successorEndpoint = routeOverride?.successorEndpoint;

    // 3. 设置响应 header
    reply.header("X-API-Version", effectiveVersion);

    if (status === "deprecated" || status === "sunset") {
      // RFC 8594: Deprecation header
      const deprecatedAt = versionCfg?.deprecatedAt ?? new Date().toISOString();
      reply.header("Deprecation", deprecatedAt);

      // Sunset header (RFC 8594)
      if (sunsetDate) {
        reply.header("Sunset", new Date(sunsetDate).toUTCString());
      }

      // Link header 指向新版本文档
      if (successorVersion) {
        reply.header("Link", `</api/${successorVersion}>; rel="successor-version"`);
      }
      if (successorEndpoint) {
        reply.header("Link", `<${successorEndpoint}>; rel="successor-version"`);
      }

      // 不兼容说明
      if (routeOverride?.breakingChangeNote) {
        reply.header("X-Breaking-Change", routeOverride.breakingChangeNote);
      }
    }

    // 4. 日落强制：返回 410 Gone
    if (enforceGone && status === "sunset" && isSunset(sunsetDate)) {
      const message = versionCfg?.sunsetMessage ?? "This API version has been sunset and is no longer available.";
      reply.status(410).send({
        errorCode: "API_VERSION_SUNSET",
        message: {
          "zh-CN": `API 版本 ${effectiveVersion} 已下线，请迁移到新版本`,
          "en-US": message,
        },
        version: effectiveVersion,
        sunsetDate,
        successorVersion: successorVersion ?? null,
      });
      return;
    }

    // 5. 注入版本信息到请求上下文（供后续中间件/路由使用）
    (req as any)._apiVersion = {
      version: effectiveVersion,
      status,
      sunsetDate,
    };
  });
};

// ---------------------------------------------------------------------------
// 辅助导出
// ---------------------------------------------------------------------------

/** 从请求中获取已解析的 API 版本信息 */
export function getRequestApiVersion(req: FastifyRequest): {
  version: string;
  status: ApiVersionStatus;
  sunsetDate?: string;
} | null {
  return (req as any)._apiVersion ?? null;
}
