export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

export const AUTH_TOKEN_KEY = "openslin_token";

function readCookieValue(name: string) {
  if (typeof document === "undefined") return "";
  const prefix = `${encodeURIComponent(name)}=`;
  const parts = document.cookie.split(";").map((x) => x.trim());
  for (const p of parts) {
    if (!p.startsWith(prefix)) continue;
    const raw = p.slice(prefix.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return "";
}

export function getClientAuthToken() {
  if (typeof window === "undefined") return "";
  try {
    const v = window.localStorage.getItem(AUTH_TOKEN_KEY);
    if (v && v.trim()) return v.trim();
  } catch {
  }
  const c = readCookieValue(AUTH_TOKEN_KEY);
  return c && c.trim() ? c.trim() : "";
}

export function setClientAuthToken(token: string) {
  const v = token.trim();
  if (typeof window !== "undefined") {
    try {
      if (v) window.localStorage.setItem(AUTH_TOKEN_KEY, v);
      else window.localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {
    }
  }
  if (typeof document !== "undefined") {
    const encoded = encodeURIComponent(v);
    if (!v) {
      document.cookie = `${encodeURIComponent(AUTH_TOKEN_KEY)}=; path=/; max-age=0`;
      return;
    }
    document.cookie = `${encodeURIComponent(AUTH_TOKEN_KEY)}=${encoded}; path=/; max-age=31536000`;
  }
}

export function apiHeaders(locale: string, opts?: { token?: string | null; tenantId?: string | null; spaceId?: string | null }) {
  const rawToken = (opts?.token ?? (typeof window !== "undefined" ? getClientAuthToken() : "") ?? "").trim();
  const headers: Record<string, string> = {
    "x-user-locale": locale,
    "x-schema-name": "core",
  };
  const tenantId = (opts?.tenantId ?? "").trim();
  if (tenantId) headers["x-tenant-id"] = tenantId;
  const spaceId = (opts?.spaceId ?? "").trim();
  if (spaceId) headers["x-space-id"] = spaceId;
  if (rawToken) {
    const lower = rawToken.toLowerCase();
    const authValue = lower.startsWith("bearer ") || lower.startsWith("device ") ? rawToken : `Bearer ${rawToken}`;
    headers.authorization = authValue;
  }
  return headers;
}

export function pickLocale(searchParams: Record<string, string | string[] | undefined>) {
  const v = searchParams.lang;
  const lang = Array.isArray(v) ? v[0] : v;
  return lang || "zh-CN";
}

export type I18nText = Record<string, string>;

export function text(text: I18nText | string | undefined, locale: string) {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[locale] ?? text["zh-CN"] ?? Object.values(text)[0] ?? "";
}
