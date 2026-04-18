import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovChannelsClient from "./ui";
import { cookies } from "next/headers";

async function loadInitial(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const [cfgRes, evRes, spacesRes] = await Promise.all([
    apiFetch(`/governance/channels/webhook/configs?limit=50`, { token, locale, cache: "no-store" }),
    apiFetch(`/governance/channels/ingress-events?status=deadletter&limit=20`, { token, locale, cache: "no-store" }),
    apiFetch(`/spaces`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) }).catch(() => null),
  ]);
  const cfgJson: unknown = await cfgRes.json().catch(() => null);
  const evJson: unknown = await evRes.json().catch(() => null);
  const spacesJson: unknown = spacesRes ? await spacesRes.json().catch(() => null) : null;
  return {
    configs: { status: cfgRes.status, json: cfgJson },
    events: { status: evRes.status, json: evJson },
    spaces: spacesJson,
  };
}

export default async function GovChannelsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadInitial(locale);
  return (
    <GovChannelsClient locale={locale} initial={initial} />
  );
}

