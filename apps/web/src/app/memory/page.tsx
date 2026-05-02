import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import MemoryManagerClient from "./ui";
import { cookies } from "next/headers";

async function loadMemories(locale: string, searchParams: SearchParams) {
  const token = (await cookies()).get("mindpal_token")?.value ?? "";
  const q = new URLSearchParams();
  const scope = Array.isArray(searchParams.scope) ? searchParams.scope[0] : searchParams.scope;
  const type = Array.isArray(searchParams.type) ? searchParams.type[0] : searchParams.type;
  const limit = Array.isArray(searchParams.limit) ? searchParams.limit[0] : searchParams.limit;
  const offset = Array.isArray(searchParams.offset) ? searchParams.offset[0] : searchParams.offset;
  if (scope) q.set("scope", scope);
  if (type) q.set("type", type);
  if (limit) q.set("limit", limit);
  if (offset) q.set("offset", offset);
  const res = await apiFetch(`/memory/entries?${q.toString()}`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function MemoryPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const out = await loadMemories(locale, searchParams);
  return <MemoryManagerClient locale={locale} initial={out.json} initialStatus={out.status} />;
}
