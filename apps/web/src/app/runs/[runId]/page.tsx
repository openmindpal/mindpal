import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import RunClient from "./ui";
import { cookies } from "next/headers";

async function loadRun(locale: string, runId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}`, { method: "GET", headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function RunPage(props: {
  params: { runId: string };
  searchParams: SearchParams | Promise<SearchParams>;
}) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const runId = decodeURIComponent(props.params.runId);
  const runRes = await loadRun(locale, runId);

  return (
    <ConsoleShell locale={locale}>
      <RunClient locale={locale} runId={runId} initial={runRes.json} initialStatus={runRes.status} />
    </ConsoleShell>
  );
}
