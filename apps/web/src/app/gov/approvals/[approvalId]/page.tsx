import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import ApprovalDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadApproval(locale: string, approvalId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/approvals/${encodeURIComponent(approvalId)}`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovApprovalDetailPage(props: {
  params: { approvalId: string };
  searchParams: SearchParams | Promise<SearchParams>;
}) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const approvalId = decodeURIComponent(props.params.approvalId);
  const detailRes = await loadApproval(locale, approvalId);
  return (
    <ConsoleShell locale={locale}>
      <ApprovalDetailClient locale={locale} approvalId={approvalId} initial={detailRes.json} initialStatus={detailRes.status} />
    </ConsoleShell>
  );
}
