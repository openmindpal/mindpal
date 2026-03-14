import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import GovModelsClient from "./ui";
import { cookies } from "next/headers";

async function loadInitial(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const [bindingsRes, catalogRes] = await Promise.all([
    fetch(`${API_BASE}/models/bindings`, { headers: apiHeaders(locale, { token }), cache: "no-store" }),
    fetch(`${API_BASE}/models/catalog`, { headers: apiHeaders(locale, { token }), cache: "no-store" }),
  ]);
  const bindingsJson: unknown = await bindingsRes.json().catch(() => null);
  const catalogJson: unknown = await catalogRes.json().catch(() => null);
  return { bindings: { status: bindingsRes.status, json: bindingsJson }, catalog: { status: catalogRes.status, json: catalogJson } };
}

export default async function GovModelsPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadInitial(locale);
  return (
    <ConsoleShell locale={locale}>
      <GovModelsClient locale={locale} initial={initial} />
    </ConsoleShell>
  );
}

