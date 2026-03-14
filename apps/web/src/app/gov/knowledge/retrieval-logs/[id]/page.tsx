import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import RetrievalLogDetailClient from "./ui";

export default async function GovKnowledgeRetrievalLogDetailPage(props: { params: Promise<{ id: string }>; searchParams: SearchParams | Promise<SearchParams> }) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return (
    <ConsoleShell locale={locale}>
      <RetrievalLogDetailClient locale={locale} id={params.id} />
    </ConsoleShell>
  );
}

