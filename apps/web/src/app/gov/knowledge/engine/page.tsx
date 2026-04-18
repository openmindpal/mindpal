import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import KnowledgeEngineClient from "./ui"; // knowledge engine

async function loadApi(locale: string, path: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  try {
    const res = await apiFetch(path, { token, locale, cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

export default async function GovKnowledgeEnginePage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const [rerankRes, embeddingRes, chunkRes, vectorRes, retrievalRes, retentionRes] = await Promise.all([
    loadApi(locale, "/governance/knowledge/rerank-configs"),
    loadApi(locale, "/governance/knowledge/embedding-configs"),
    loadApi(locale, "/governance/knowledge/chunk-configs"),
    loadApi(locale, "/governance/knowledge/vector-store-configs"),
    loadApi(locale, "/governance/knowledge/retrieval-strategies"),
    loadApi(locale, "/governance/knowledge/retention-policies"),
  ]);
  return (
    <KnowledgeEngineClient
      locale={locale}
      rerankInitial={rerankRes.json}
      embeddingInitial={embeddingRes.json}
      chunkInitial={chunkRes.json}
      vectorStoreInitial={vectorRes.json}
      retrievalInitial={retrievalRes.json}
      retentionInitial={retentionRes.json}
    />
  );
}
