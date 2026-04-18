import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import BackupsClient from "./ui";
import { cookies } from "next/headers";

async function loadSpaces(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch("/spaces", { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function BackupsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const out = await loadSpaces(locale);
  return <BackupsClient locale={locale} initialSpaces={out.json} initialSpacesStatus={out.status} />;
}
