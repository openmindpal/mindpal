import { resolveFallbackRequestDlpPolicyContext, type RequestDlpPolicyContext } from "./dlpPolicy";
import { sanitizeSseEvent } from "./streamDlp";

export function openSse(params: {
  req: any;
  reply: any;
  headers?: Record<string, string>;
  dlpContext?: RequestDlpPolicyContext;
  onClose?: () => void | Promise<void>;
}) {
  const req = params.req;
  const reply = params.reply;
  const dlpContext = params.dlpContext ?? resolveFallbackRequestDlpPolicyContext();

  const ctrl = new AbortController();

  // P2-6.7: SSE 响应头自动携带 traceId，支持全链路追踪
  const traceId = req.ctx?.traceId as string | undefined;
  const sseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(traceId ? { "X-Trace-Id": traceId } : {}),
    ...(params.headers ?? {}),
  };

  const origin = req.headers?.origin as string | undefined;
  if (origin) {
    const existing = reply.getHeader?.("access-control-allow-origin");
    if (existing) {
      sseHeaders["Access-Control-Allow-Origin"] = String(existing);
      sseHeaders["Access-Control-Allow-Credentials"] = "true";
      sseHeaders["Vary"] = "origin";
    }
  }

  reply.raw.writeHead(200, sseHeaders);
  if (typeof (reply.raw as any).flushHeaders === "function") (reply.raw as any).flushHeaders();

  let closed = false;
  let closeHookFired = false;
  const runOnClose = () => {
    if (closeHookFired) return;
    closeHookFired = true;
    if (!params.onClose) return;
    void Promise.resolve(params.onClose()).catch(() => {});
  };
  const onClose = () => {
    closed = true;
    try {
      ctrl.abort();
    } catch {
    }
    runOnClose();
  };
  req.raw.on("close", onClose);
  reply.raw.on("close", onClose);

  function sendEvent(event: string, data: unknown) {
    if (closed) return;
    try {
      const sanitized = sanitizeSseEvent({ event, data, req, dlpContext });
      reply.raw.write(`event: ${sanitized.event}\ndata: ${JSON.stringify(sanitized.data)}\n\n`);
      if (sanitized.denied) {
        close();
      }
    } catch {
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      ctrl.abort();
    } catch {
    }
    try {
      req.raw.off("close", onClose);
      reply.raw.off("close", onClose);
    } catch {
    }
    try {
      reply.raw.end();
    } catch {
    }
    runOnClose();
  }

  return {
    sendEvent,
    close,
    abortController: ctrl,
    signal: ctrl.signal,
    isClosed: () => closed,
  };
}
