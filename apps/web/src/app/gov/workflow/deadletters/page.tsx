import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import { cookies } from "next/headers";
import DeadlettersClient from "./ui.tsx";

async function loadDeadletters(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/workflow/deadletters?limit=50`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovWorkflowDeadlettersPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const deadlettersRes = await loadDeadletters(locale);
  return (
    <ConsoleShell locale={locale}>
      <DeadlettersClient locale={locale} initial={deadlettersRes.json} initialStatus={deadlettersRes.status} />
    </ConsoleShell>
  );
}
