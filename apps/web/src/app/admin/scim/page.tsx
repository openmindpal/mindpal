import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import { cookies } from "next/headers";
import ScimConfigClient from "./ui";
import type { SearchParams } from "@/lib/types";

export default async function ScimConfigPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const token = (await cookies()).get("mindpal_token")?.value ?? "";

  const configsRes = await apiFetch(`/scim/v2/admin/configs`, {
    locale,
    token,
    cache: "no-store",
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });

  const configsJson = configsRes.ok ? await configsRes.json() : await configsRes.json().catch(() => null);

  return (
    <ScimConfigClient
      locale={locale}
      initial={{ configs: configsJson, status: configsRes.status }}
    />
  );
}
