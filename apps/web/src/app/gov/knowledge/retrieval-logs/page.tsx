import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import RetrievalLogsClient from "./ui";

export default async function GovKnowledgeRetrievalLogsPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return (
    <ConsoleShell locale={locale}>
      <RetrievalLogsClient locale={locale} />
    </ConsoleShell>
  );
}
