import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import GovToolsClient from "./ui";
import { cookies } from "next/headers";

async function loadTools(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/tools`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovToolsPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const toolsRes = await loadTools(locale);
  return (
    <ConsoleShell locale={locale}>
      <GovToolsClient locale={locale} initial={toolsRes.json} initialStatus={toolsRes.status} />
    </ConsoleShell>
  );
}
