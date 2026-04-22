import { context, propagation } from "@opentelemetry/api";
import { resolveBoolean, injectTraceHeaders, createTraceContext } from "@openslin/shared";

export function attachJobTraceCarrier<T extends Record<string, any>>(data: T): T {
  // Inject unified x-trace-id headers
  const unifiedTrace = createTraceContext();
  const unifiedHeaders = injectTraceHeaders(unifiedTrace);
  let merged = { ...data, __unifiedTrace: unifiedHeaders };

  const enabled = resolveBoolean("OTEL_ENABLED").value;
  if (!enabled) return merged as T;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!Object.keys(carrier).length) return merged as T;
  return { ...merged, __trace: carrier } as T;
}

export function extractJobTraceContext(data: any) {
  const enabled = resolveBoolean("OTEL_ENABLED").value;
  if (!enabled) return context.active();
  const carrier = data?.__trace;
  if (!carrier || typeof carrier !== "object") return context.active();
  return propagation.extract(context.active(), carrier as any);
}

