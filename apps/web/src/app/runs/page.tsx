import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import RunsClient from "./ui";
import { cookies } from "next/headers";

function pickFirst(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

async function loadRuns(locale: string, searchParams: SearchParams) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const q = new URLSearchParams();
  const status = pickFirst(searchParams.status);
  const updatedFrom = pickFirst(searchParams.updatedFrom);
  const updatedTo = pickFirst(searchParams.updatedTo);
  const limit = pickFirst(searchParams.limit);
  if (status) q.set("status", status);
  if (updatedFrom) q.set("updatedFrom", updatedFrom);
  if (updatedTo) q.set("updatedTo", updatedTo);
  if (limit) q.set("limit", limit);
  const res = await fetch(`${API_BASE}/runs?${q.toString()}`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json, initialQuery: { status, updatedFrom, updatedTo, limit } };
}

export default async function RunsPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const runsRes = await loadRuns(locale, searchParams);
  return (
    <ConsoleShell locale={locale}>
      <RunsClient locale={locale} initial={runsRes.json} initialStatus={runsRes.status} initialQuery={runsRes.initialQuery} />
    </ConsoleShell>
  );
}
