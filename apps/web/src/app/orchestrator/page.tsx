import type { SearchParams } from "@/lib/types";
import { pickLocale } from "@/lib/api";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import OrchestratorPlaygroundClient from "./ui";

export default async function OrchestratorPlaygroundPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return (
    <ConsoleShell locale={locale}>
      <OrchestratorPlaygroundClient locale={locale} />
    </ConsoleShell>
  );
}

