import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import ChangeSetsClient from "./ui";
import { cookies } from "next/headers";

async function loadChangeSets(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/changesets?limit=20`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadPipelines(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/changesets/pipelines?limit=20&mode=full`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovChangeSetsPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const listRes = await loadChangeSets(locale);
  const pipeRes = await loadPipelines(locale);
  return (
    <ConsoleShell locale={locale}>
      <ChangeSetsClient locale={locale} initial={listRes.json} initialStatus={listRes.status} initialPipelines={pipeRes.json} initialPipelinesStatus={pipeRes.status} />
    </ConsoleShell>
  );
}
