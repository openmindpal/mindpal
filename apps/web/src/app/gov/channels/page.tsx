import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import GovChannelsClient from "./ui";
import { cookies } from "next/headers";

async function loadInitial(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const [cfgRes, evRes] = await Promise.all([
    fetch(`${API_BASE}/governance/channels/webhook/configs?limit=50`, { headers: apiHeaders(locale, { token }), cache: "no-store" }),
    fetch(`${API_BASE}/governance/channels/ingress-events?status=deadletter&limit=20`, { headers: apiHeaders(locale, { token }), cache: "no-store" }),
  ]);
  const cfgJson: unknown = await cfgRes.json().catch(() => null);
  const evJson: unknown = await evRes.json().catch(() => null);
  return { configs: { status: cfgRes.status, json: cfgJson }, events: { status: evRes.status, json: evJson } };
}

export default async function GovChannelsPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadInitial(locale);
  return (
    <ConsoleShell locale={locale}>
      <GovChannelsClient locale={locale} initial={initial} />
    </ConsoleShell>
  );
}

