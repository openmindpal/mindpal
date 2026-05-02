import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import RetrievalLogsClient from "./ui";

async function loadLogs(locale: string) {
  const token = (await cookies()).get("mindpal_token")?.value ?? "";
  const res = await apiFetch(`/governance/knowledge/retrieval-logs?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovKnowledgeRetrievalLogsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadLogs(locale);
  return <RetrievalLogsClient locale={locale} initial={initial} />;
}
