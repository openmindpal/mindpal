import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import FederationClient from "./ui";

async function loadFederationStatus(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/federation/status`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadFederationNodes(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/federation/nodes?limit=100`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovFederationPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);

  const [statusRes, nodesRes] = await Promise.all([
    loadFederationStatus(locale),
    loadFederationNodes(locale),
  ]);

  // Merge status and node data
  const initial = {
    status: statusRes.status,
    json: {
      status: (statusRes.json as any)?.status ?? null,
      activeNodes: (statusRes.json as any)?.activeNodes ?? 0,
      nodes: (nodesRes.json as any)?.nodes ?? [],
    },
  };

  return <FederationClient locale={locale} initial={initial} />;
}
