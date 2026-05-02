import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import { cookies } from "next/headers";
import OrganizationsClient from "./ui";
import type { SearchParams } from "@/lib/types";

export default async function OrganizationsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const token = (await cookies()).get("mindpal_token")?.value ?? "";

  const [orgUnitsRes, spacesRes] = await Promise.all([
    apiFetch(`/org/units`, {
      locale,
      token,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    }),
    apiFetch(`/spaces`, {
      locale,
      token,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    }),
  ]);

  const orgUnitsJson = orgUnitsRes.ok ? await orgUnitsRes.json() : await orgUnitsRes.json().catch(() => null);
  const spacesJson = spacesRes.ok ? await spacesRes.json() : await spacesRes.json().catch(() => null);

  return (
    <OrganizationsClient
      locale={locale}
      initial={{
        orgUnits: orgUnitsJson,
        spaces: spacesJson,
        orgUnitsStatus: orgUnitsRes.status,
        spacesStatus: spacesRes.status,
      }}
    />
  );
}
