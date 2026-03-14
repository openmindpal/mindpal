import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import GovPolicySnapshotDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadExplain(locale: string, snapshotId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/policy/snapshots/${encodeURIComponent(snapshotId)}/explain`, {
    headers: apiHeaders(locale, { token }),
    cache: "no-store",
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovPolicySnapshotDetailPage(props: {
  params: { snapshotId: string } | Promise<{ snapshotId: string }>;
  searchParams: SearchParams | Promise<SearchParams>;
}) {
  const params = await Promise.resolve(props.params);
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadExplain(locale, params.snapshotId);
  return (
    <ConsoleShell locale={locale}>
      <GovPolicySnapshotDetailClient locale={locale} snapshotId={params.snapshotId} initial={initial.json} initialStatus={initial.status} />
    </ConsoleShell>
  );
}
