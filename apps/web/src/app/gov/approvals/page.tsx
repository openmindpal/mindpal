import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import ApprovalsClient from "./ui";
import { cookies } from "next/headers";

async function loadApprovals(locale: string) {
  try {
    const token = (await cookies()).get("openslin_token")?.value ?? "";
    const res = await apiFetch(`/approvals?limit=50`, {
      token,
      locale,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    console.error("[GovApprovalsPage] loadApprovals failed:", msg);
    return { status: 502, json: { errorCode: "FETCH_FAILED", message: msg } };
  }
}

export default async function GovApprovalsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await props.searchParams;
  const locale = pickLocale(searchParams);
  const approvalsRes = await loadApprovals(locale);
  return (
    <ApprovalsClient locale={locale} initial={approvalsRes.json} initialStatus={approvalsRes.status} />
  );
}
