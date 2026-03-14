import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import EvalRunClient from "./ui";
import { cookies } from "next/headers";

async function loadEvalRun(locale: string, id: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/evals/runs/${encodeURIComponent(id)}`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function EvalRunPage(props: { params: { id: string }; searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const id = decodeURIComponent(props.params.id);
  const out = await loadEvalRun(locale, id);
  return (
    <ConsoleShell locale={locale}>
      <EvalRunClient locale={locale} runId={id} initial={out.json} initialStatus={out.status} />
    </ConsoleShell>
  );
}

