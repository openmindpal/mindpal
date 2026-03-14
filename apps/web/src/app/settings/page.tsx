import { pickLocale } from "../../lib/api";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import type { SearchParams } from "../../lib/types";
import SettingsClient from "./ui";

export default async function SettingsPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return (
    <ConsoleShell locale={locale}>
      <SettingsClient locale={locale} />
    </ConsoleShell>
  );
}
