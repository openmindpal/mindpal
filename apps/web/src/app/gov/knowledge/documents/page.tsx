import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import KnowledgeDocumentsClient from "./ui";

async function loadDocuments(locale: string) {
  const token = (await cookies()).get("mindpal_token")?.value ?? "";
  const res = await apiFetch(`/governance/knowledge/documents?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovKnowledgeDocumentsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadDocuments(locale);
  return <KnowledgeDocumentsClient locale={locale} initial={initial} />;
}
