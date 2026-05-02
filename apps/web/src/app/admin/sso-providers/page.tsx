import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import { cookies } from "next/headers";
import SsoProvidersClient from "./ui";
import type { SearchParams } from "@/lib/types";

export default async function SsoProvidersPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const token = (await cookies()).get("mindpal_token")?.value ?? "";

  const providersRes = await apiFetch(`/sso/providers`, {
    locale,
    token,
    cache: "no-store",
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });

  const providersJson = providersRes.ok ? await providersRes.json() : await providersRes.json().catch(() => null);

  return (
    <SsoProvidersClient
      locale={locale}
      initial={{ providers: providersJson, status: providersRes.status }}
    />
  );
}
