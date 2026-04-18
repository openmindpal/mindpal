import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import DeadlettersClient from "./ui.tsx";

async function loadDeadletters(locale: string) {
  try {
    const token = (await cookies()).get("openslin_token")?.value ?? "";
    const res = await apiFetch(`/governance/workflow/deadletters?limit=50`, {
      token,
      locale,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    console.error("[GovWorkflowDeadlettersPage] loadDeadletters failed:", msg);
    return { status: 502, json: { errorCode: "FETCH_FAILED", message: msg } };
  }
}

export default async function GovWorkflowDeadlettersPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await props.searchParams;
  const locale = pickLocale(searchParams);
  const deadlettersRes = await loadDeadletters(locale);
  return (
    <DeadlettersClient locale={locale} initial={deadlettersRes.json} initialStatus={deadlettersRes.status} />
  );
}
