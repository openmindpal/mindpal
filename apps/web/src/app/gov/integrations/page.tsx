import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import IntegrationsClient from "./ui";

async function loadIntegrations(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const q = new URLSearchParams();
  q.set("limit", "50");
  q.set("offset", "0");
  q.set("scopeType", "space");
  const res = await apiFetch(`/governance/integrations?${q.toString()}`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovIntegrationsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadIntegrations(locale);
  return <IntegrationsClient locale={locale} initial={initial} />;
}

