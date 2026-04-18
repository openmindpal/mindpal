/**
 * structuredLogger.ts — P3-01: 统一结构化日志标准
 *
 * 功能：
 * - JSON 结构化输出（每行一条 JSON，便于 ELK/Loki/Datadog 采集）
 * - 必填字段：level, timestamp, module, message
 * - 可选上下文字段：traceId, requestId, tenantId, spaceId, subjectId
 * - 自动敏感字段脱敏（authorization, password, token, apiKey, secret 等）
 * - 路径级采样策略（health/metrics 0%, 正常 10%, 错误 100%）
 * - 子日志器继承上下文
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** 日志级别优先级（数值越大越高） */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/** 结构化日志条目 */
export interface StructuredLogEntry {
  /** 日志级别 */
  level: LogLevel;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 产生日志的模块名 */
  module: string;
  /** 人类可读消息 */
  message: string;
  /** 分布式追踪 ID */
  traceId?: string;
  /** 请求 ID */
  requestId?: string;
  /** 租户 ID */
  tenantId?: string;
  /** 空间 ID */
  spaceId?: string;
  /** 操作人 ID */
  subjectId?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 错误码 */
  errorCode?: string;
  /** 错误详情 */
  error?: { message: string; stack?: string; code?: string };
  /** 额外结构化字段 */
  extra?: Record<string, unknown>;
}

/** 日志上下文（可继承的字段） */
export interface LogContext {
  traceId?: string;
  requestId?: string;
  tenantId?: string;
  spaceId?: string;
  subjectId?: string;
  [key: string]: unknown;
}

/** 采样规则 */
export interface SamplingRule {
  /** 匹配路径前缀 */
  pathPrefix: string;
  /** 采样率 0.0 ~ 1.0 */
  rate: number;
  /** 是否仅对 info 及以下级别采样（error/fatal 始终输出） */
  infoOnly?: boolean;
}

/** 日志器配置 */
export interface StructuredLoggerConfig {
  /** 最低输出级别（默认 info，生产建议 info，开发 debug） */
  minLevel?: LogLevel;
  /** 模块名 */
  module: string;
  /** 初始上下文 */
  context?: LogContext;
  /** 是否美化输出（开发模式，默认 false） */
  pretty?: boolean;
  /** 采样规则（可选） */
  samplingRules?: SamplingRule[];
  /** 自定义输出函数（默认 process.stdout.write） */
  output?: (line: string) => void;
  /** 是否启用脱敏（默认 true） */
  redactEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Redaction — 敏感字段脱敏
// ---------------------------------------------------------------------------

/** 默认需要脱敏的 key 模式 */
const REDACT_KEY_PATTERNS = [
  /authorization/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /api[-_]?secret/i,
  /private[-_]?key/i,
  /access[-_]?key/i,
  /credential/i,
  /session[-_]?id/i,
  /cookie/i,
  /x-api-key/i,
  /bearer/i,
];

/** 脱敏替换值 */
const REDACTED = "[REDACTED]";

/** 检查 key 是否需要脱敏 */
function isRedactedKey(key: string): boolean {
  return REDACT_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * 深度脱敏对象中的敏感字段。
 * 仅处理 plain object，不修改原对象，返回新对象。
 */
export function redactSensitiveFields(value: unknown, maxDepth = 8): unknown {
  if (maxDepth <= 0 || value == null) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitiveFields(v, maxDepth - 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isRedactedKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSensitiveFields(v, maxDepth - 1);
      }
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Sampling — 日志采样
// ---------------------------------------------------------------------------

/** 默认采样规则 */
export const DEFAULT_SAMPLING_RULES: SamplingRule[] = [
  // 健康检查和指标路由：0% 采样（不输出 info/debug）
  { pathPrefix: "/healthz", rate: 0, infoOnly: true },
  { pathPrefix: "/readyz", rate: 0, infoOnly: true },
  { pathPrefix: "/metrics", rate: 0, infoOnly: true },
  // 正常请求路由：10% 采样（info 级别仅输出 10%）
  { pathPrefix: "/", rate: 0.1, infoOnly: true },
];

/**
 * 判断当前日志是否应该被采样输出。
 *
 * 规则：
 * - error / fatal / warn：始终输出（100%）
 * - info / debug：按匹配的采样规则决定
 * - 无匹配规则：默认输出
 */
export function shouldSample(params: {
  level: LogLevel;
  path?: string;
  rules: SamplingRule[];
}): boolean {
  const { level, path, rules } = params;

  // error / fatal / warn 始终输出
  if (LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY.warn) return true;

  // 无路径信息或无规则时默认输出
  if (!path || rules.length === 0) return true;

  // 从最长匹配开始（具体路径优先）
  let matchedRule: SamplingRule | null = null;
  for (const rule of rules) {
    if (path.startsWith(rule.pathPrefix)) {
      if (!matchedRule || rule.pathPrefix.length > matchedRule.pathPrefix.length) {
        matchedRule = rule;
      }
    }
  }

  if (!matchedRule) return true;
  if (matchedRule.infoOnly && LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY.warn) return true;

  // 按采样率决定
  return Math.random() < matchedRule.rate;
}

// ---------------------------------------------------------------------------
// StructuredLogger 类
// ---------------------------------------------------------------------------

export class StructuredLogger {
  private config: Required<
    Pick<StructuredLoggerConfig, "minLevel" | "module" | "pretty" | "redactEnabled">
  > & {
    context: LogContext;
    samplingRules: SamplingRule[];
    output: (line: string) => void;
  };

  constructor(config: StructuredLoggerConfig) {
    this.config = {
      minLevel: config.minLevel ?? "info",
      module: config.module,
      context: config.context ?? {},
      pretty: config.pretty ?? false,
      samplingRules: config.samplingRules ?? [],
      output: config.output ?? ((line: string) => {
        try { process.stdout.write(line + "\n"); } catch { /* ignore */ }
      }),
      redactEnabled: config.redactEnabled ?? true,
    };
  }

  // ── Level 方法 ──────────────────────────────────────────

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log("debug", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log("info", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log("warn", message, extra);
  }

  error(message: string, errorOrExtra?: Error | Record<string, unknown>): void {
    if (errorOrExtra instanceof Error) {
      this.log("error", message, {
        error: {
          message: errorOrExtra.message,
          stack: errorOrExtra.stack,
          code: (errorOrExtra as any).code,
        },
      });
    } else {
      this.log("error", message, errorOrExtra);
    }
  }

  fatal(message: string, errorOrExtra?: Error | Record<string, unknown>): void {
    if (errorOrExtra instanceof Error) {
      this.log("fatal", message, {
        error: {
          message: errorOrExtra.message,
          stack: errorOrExtra.stack,
          code: (errorOrExtra as any).code,
        },
      });
    } else {
      this.log("fatal", message, errorOrExtra);
    }
  }

  // ── 子日志器 ──────────────────────────────────────────

  /**
   * 创建继承当前上下文的子日志器。
   * 典型用途：请求级别日志器继承 traceId/requestId/tenantId
   */
  child(childContext: LogContext & { module?: string }): StructuredLogger {
    const { module: childModule, ...rest } = childContext;
    return new StructuredLogger({
      ...this.config,
      module: childModule ?? this.config.module,
      context: { ...this.config.context, ...rest },
    });
  }

  // ── 核心日志方法 ──────────────────────────────────────

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    // 级别过滤
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) return;

    // 采样过滤
    const path = (extra?.path ?? this.config.context.path) as string | undefined;
    if (!shouldSample({ level, path, rules: this.config.samplingRules })) return;

    // 构建日志条目
    const entry: StructuredLogEntry = {
      level,
      timestamp: new Date().toISOString(),
      module: this.config.module,
      message,
    };

    // 注入上下文字段
    const ctx = this.config.context;
    if (ctx.traceId) entry.traceId = String(ctx.traceId);
    if (ctx.requestId) entry.requestId = String(ctx.requestId);
    if (ctx.tenantId) entry.tenantId = String(ctx.tenantId);
    if (ctx.spaceId) entry.spaceId = String(ctx.spaceId);
    if (ctx.subjectId) entry.subjectId = String(ctx.subjectId);

    // 合并额外字段
    if (extra) {
      if (extra.durationMs !== undefined) entry.durationMs = Number(extra.durationMs);
      if (extra.errorCode !== undefined) entry.errorCode = String(extra.errorCode);
      if (extra.error !== undefined) entry.error = extra.error as any;

      // 其他字段放入 extra
      const remaining: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(extra)) {
        if (k !== "durationMs" && k !== "errorCode" && k !== "error" && k !== "path") {
          remaining[k] = v;
        }
      }
      if (Object.keys(remaining).length > 0) {
        entry.extra = remaining;
      }
    }

    // 脱敏
    const output = this.config.redactEnabled
      ? redactSensitiveFields(entry) as StructuredLogEntry
      : entry;

    // 序列化
    const line = this.config.pretty
      ? JSON.stringify(output, null, 2)
      : JSON.stringify(output);

    this.config.output(line);
  }

  // ── 工具方法 ──────────────────────────────────────────

  /** 获取当前模块名 */
  getModule(): string {
    return this.config.module;
  }

  /** 获取当前上下文 */
  getContext(): LogContext {
    return { ...this.config.context };
  }

  /** 设置最低级别 */
  setMinLevel(level: LogLevel): void {
    this.config.minLevel = level;
  }
}

// ---------------------------------------------------------------------------
// 全局日志器工厂
// ---------------------------------------------------------------------------

let _rootLogger: StructuredLogger | null = null;

/**
 * 初始化全局根日志器。
 * 应在应用启动时调用一次。
 */
export function initRootLogger(config: StructuredLoggerConfig): StructuredLogger {
  _rootLogger = new StructuredLogger(config);
  return _rootLogger;
}

/**
 * 获取全局根日志器。
 * 如果未初始化，则创建一个默认日志器。
 */
export function getRootLogger(): StructuredLogger {
  if (!_rootLogger) {
    _rootLogger = new StructuredLogger({
      module: "app",
      minLevel: (process.env.NODE_ENV === "production") ? "info" : "debug",
      samplingRules: DEFAULT_SAMPLING_RULES,
    });
  }
  return _rootLogger;
}

/**
 * 创建模块级日志器。
 * @example
 * const log = createModuleLogger("db:pool");
 * log.info("Pool created", { max: 20, min: 2 });
 */
export function createModuleLogger(module: string, context?: LogContext): StructuredLogger {
  return getRootLogger().child({ ...context, module });
}

// ---------------------------------------------------------------------------
// Fastify 请求日志工具
// ---------------------------------------------------------------------------

/**
 * 为 Fastify 请求创建请求级子日志器。
 *
 * @example
 * app.addHook("onRequest", (req) => {
 *   req.log = createRequestLogger(req);
 * });
 */
export function createRequestLogContext(req: {
  ctx?: { traceId?: string; requestId?: string; subject?: { tenantId?: string; spaceId?: string; subjectId?: string } };
  url?: string;
}): LogContext {
  const ctx = req.ctx;
  return {
    traceId: ctx?.traceId,
    requestId: ctx?.requestId,
    tenantId: ctx?.subject?.tenantId,
    spaceId: ctx?.subject?.spaceId,
    subjectId: ctx?.subject?.subjectId,
    path: req.url?.split("?")[0],
  };
}

// ---------------------------------------------------------------------------
// Utility: 安全的 JSON.stringify（处理循环引用）
// ---------------------------------------------------------------------------

export function safeStringify(value: unknown, maxLength = 10000): string {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      if (typeof val === "bigint") return val.toString();
      return val;
    });
    if (json && json.length > maxLength) {
      return json.slice(0, maxLength) + `...[truncated, total=${json.length}]`;
    }
    return json ?? "undefined";
  } catch {
    return String(value);
  }
}
