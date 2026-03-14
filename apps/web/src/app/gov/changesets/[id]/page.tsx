import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import ChangeSetDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadChangeSet(locale: string, id: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/changesets/${encodeURIComponent(id)}`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovChangeSetDetailPage(props: {
  params: { id: string };
  searchParams: SearchParams | Promise<SearchParams>;
}) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const id = decodeURIComponent(props.params.id);
  const detailRes = await loadChangeSet(locale, id);
  return (
    <ConsoleShell locale={locale}>
      <ChangeSetDetailClient locale={locale} changesetId={id} initial={detailRes.json} initialStatus={detailRes.status} />
    </ConsoleShell>
  );
}
