/**
 * 通用 API 客户端 — 统一封装所有 HTTP 调用
 *
 * 自动处理：Bearer token、租户/空间/traceId headers、错误格式化
 */

export interface ApiClientOptions {
  apiBase: string;
  token: string;
  tenantId?: string;
  spaceId?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
}

function buildHeaders(opts: ApiClientOptions, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.token}`,
    "x-trace-id": `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  if (opts.tenantId) h["x-tenant-id"] = opts.tenantId;
  if (opts.spaceId) h["x-space-id"] = opts.spaceId;
  if (extra) Object.assign(h, extra);
  return h;
}

async function request<T = unknown>(
  method: string,
  opts: ApiClientOptions,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<ApiResponse<T>> {
  const url = `${opts.apiBase}${path}`;
  const init: RequestInit = {
    method,
    headers: buildHeaders(opts, extraHeaders),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

export function apiGet<T = unknown>(opts: ApiClientOptions, path: string, extraHeaders?: Record<string, string>) {
  return request<T>("GET", opts, path, undefined, extraHeaders);
}

export function apiPost<T = unknown>(opts: ApiClientOptions, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return request<T>("POST", opts, path, body, extraHeaders);
}

export function apiPut<T = unknown>(opts: ApiClientOptions, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return request<T>("PUT", opts, path, body, extraHeaders);
}

export function apiPatch<T = unknown>(opts: ApiClientOptions, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return request<T>("PATCH", opts, path, body, extraHeaders);
}

export function apiDelete<T = unknown>(opts: ApiClientOptions, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return request<T>("DELETE", opts, path, body, extraHeaders);
}

/** 构建 query string（自动忽略 undefined/空值） */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  return p.size ? `?${p.toString()}` : "";
}
