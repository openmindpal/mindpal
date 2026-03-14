import { ConsoleShell } from "@/components/shell/ConsoleShell";
import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import { cookies } from "next/headers";
import type { SearchParams } from "@/lib/types";
import WorkbenchHostClient from "./ui";

async function loadEffective(locale: string, workbenchKey: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/workbenches/${encodeURIComponent(workbenchKey)}/effective`, {
    method: "GET",
    headers: apiHeaders(locale, { token }),
    cache: "no-store",
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function WorkbenchPage(props: { params: { workbenchKey: string }; searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const effective = await loadEffective(locale, props.params.workbenchKey);
  return (
    <ConsoleShell locale={locale}>
      <WorkbenchHostClient locale={locale} workbenchKey={props.params.workbenchKey} initial={effective.json} initialStatus={effective.status} />
    </ConsoleShell>
  );
}

