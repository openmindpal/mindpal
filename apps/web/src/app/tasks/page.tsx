import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import TasksClient from "./ui";
import { cookies } from "next/headers";

function pickFirst(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

async function loadLongTasks(locale: string, searchParams: SearchParams) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const q = new URLSearchParams();
  const scope = pickFirst(searchParams.scope);
  const limit = pickFirst(searchParams.limit);
  const offset = pickFirst(searchParams.offset);
  if (scope) q.set("scope", scope);
  if (limit) q.set("limit", limit);
  if (offset) q.set("offset", offset);
  const res = await fetch(`${API_BASE}/tasks/long-tasks?${q.toString()}`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json, initialQuery: { scope, limit, offset } };
}

export default async function TasksPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const out = await loadLongTasks(locale, searchParams);
  return (
    <ConsoleShell locale={locale}>
      <TasksClient locale={locale} initial={out.json} initialStatus={out.status} initialQuery={out.initialQuery} />
    </ConsoleShell>
  );
}

