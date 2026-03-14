import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import KnowledgeQualityClient from "./ui";

export default async function GovKnowledgeQualityPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return (
    <ConsoleShell locale={locale}>
      <KnowledgeQualityClient locale={locale} />
    </ConsoleShell>
  );
}

