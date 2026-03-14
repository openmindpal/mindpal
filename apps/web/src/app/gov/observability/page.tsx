import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import { cookies } from "next/headers";
import GovObservabilityClient from "./ui";

async function loadSummary(locale: string, window: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const q = new URLSearchParams();
  if (window) q.set("window", window);
  const res = await fetch(`${API_BASE}/governance/observability/summary?${q.toString()}`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovObservabilityPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const window = typeof searchParams.window === "string" ? searchParams.window : "1h";
  const initial = await loadSummary(locale, window);
  return (
    <ConsoleShell locale={locale}>
      <GovObservabilityClient locale={locale} initial={initial.json} initialStatus={initial.status} initialWindow={window} />
    </ConsoleShell>
  );
}

