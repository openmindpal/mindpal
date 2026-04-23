/**
 * otelBootstrap.ts — 参数化 OTel 初始化，消除 api/worker 重复代码
 *
 * P3-14: 增强支持 Jaeger OTLP 端点配置
 *
 * 环境变量：
 * - OTEL_ENABLED=1|true          启用 OTel
 * - OTEL_DIAG=1|true              启用诊断日志
 * - OTEL_EXPORTER_OTLP_ENDPOINT   OTLP 端点 (默认 http://localhost:4318)
 * - OTEL_EXPORTER_OTLP_HEADERS    OTLP headers (k=v 逗号分隔)
 * - OTEL_SERVICE_VERSION           服务版本号
 * - OTEL_DEPLOYMENT_ENVIRONMENT   部署环境 (dev/staging/prod)
 *
 * 用法（在 app 入口）：
 *   import { bootstrapOtel } from "@openslin/shared";
 *   bootstrapOtel({ serviceName: "openslin-api", ... });
 */

import { resolveBoolean, resolveString } from "./runtimeConfig";

export function parseOtelHeaders(raw: string | undefined): Record<string, string> | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 检查 OTel 是否启用 */
export function isOtelEnabled(): boolean {
  return resolveBoolean("OTEL_ENABLED").value;
}

/** 获取默认 OTLP 端点（优先 Jaeger docker-compose 默认） */
export function getOtlpEndpoint(): string {
  return resolveString("OTEL_EXPORTER_OTLP_ENDPOINT").value || "http://localhost:4318";
}

/**
 * 初始化 OpenTelemetry SDK（依赖注入模式，避免 shared 引入 OTel 依赖）
 *
 * P3-14: 增加 service.version / deployment.environment 资源属性，
 * 支持 Jaeger 通过 OTLP HTTP 收集。
 */
export function bootstrapOtel(params: {
  serviceName: string;
  serviceVersion?: string;
  deps: {
    diag: { setLogger(logger: any, level: any): void };
    DiagConsoleLogger: new () => any;
    DiagLogLevel: { INFO: any };
    OTLPTraceExporter: new (opts: { url?: string; headers?: Record<string, string> }) => any;
    Resource: new (attrs: Record<string, string>) => any;
    NodeSDK: new (opts: { resource: any; traceExporter: any; instrumentations: any[] }) => any;
    SEMRESATTRS_SERVICE_NAME: string;
    getNodeAutoInstrumentations: () => any[];
  };
}) {
  if (!isOtelEnabled()) return;

  const { deps } = params;
  const diagEnabled = resolveBoolean("OTEL_DIAG").value;
  if (diagEnabled) deps.diag.setLogger(new deps.DiagConsoleLogger(), deps.DiagLogLevel.INFO);

  // P3-14: 默认指向 Jaeger OTLP HTTP (docker-compose port 4318)
  const endpoint = getOtlpEndpoint();
  const exporter = new deps.OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers: parseOtelHeaders(resolveString("OTEL_EXPORTER_OTLP_HEADERS").value || undefined),
  });

  // P3-14: 增加 service.version + deployment.environment 资源属性
  const resourceAttrs: Record<string, string> = {
    [deps.SEMRESATTRS_SERVICE_NAME]: params.serviceName,
  };
  const version = params.serviceVersion || resolveString("OTEL_SERVICE_VERSION").value;
  if (version) resourceAttrs["service.version"] = version;
  const env = resolveString("OTEL_DEPLOYMENT_ENVIRONMENT").value;
  if (env) resourceAttrs["deployment.environment"] = env;

  const sdk = new deps.NodeSDK({
    resource: new deps.Resource(resourceAttrs),
    traceExporter: exporter,
    instrumentations: [deps.getNodeAutoInstrumentations()],
  });

  sdk.start();

  if (diagEnabled) {
    console.log(`[OTel] SDK started for ${params.serviceName} → ${endpoint}`);
  }

  process.on("SIGTERM", () => {
    sdk.shutdown().catch(() => null);
  });
}

/* ─── 自适应采样器 ─────────────────────────────────── */

/** 自适应采样器配置 */
export interface AdaptiveSamplerOpts {
  /** 默认采样率 (0.0-1.0)，默认 0.1 */
  baseRate?: number;
  /** 错误时采样率，默认 1.0 */
  errorRate?: number;
  /** 高延迟阈值（毫秒），默认 5000 */
  highLatencyThresholdMs?: number;
  /** 高延迟时采样率，默认 0.5 */
  highLatencyRate?: number;
}

/**
 * 创建自适应采样决策函数
 * - 正常请求按 baseRate 随机采样
 * - 错误请求按 errorRate 采样（通常 100%）
 * - 高延迟请求按 highLatencyRate 采样
 *
 * 返回函数：(isError, latencyMs?) => boolean
 */
export function createAdaptiveSampler(opts?: AdaptiveSamplerOpts): (isError: boolean, latencyMs?: number) => boolean {
  const baseRate = opts?.baseRate ?? 0.1;
  const errorRate = opts?.errorRate ?? 1.0;
  const highLatencyThresholdMs = opts?.highLatencyThresholdMs ?? 5000;
  const highLatencyRate = opts?.highLatencyRate ?? 0.5;

  return (isError: boolean, latencyMs?: number): boolean => {
    if (isError) return Math.random() < errorRate;
    if (latencyMs !== undefined && latencyMs > highLatencyThresholdMs) return Math.random() < highLatencyRate;
    return Math.random() < baseRate;
  };
}
