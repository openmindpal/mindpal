import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import GovDevicesClient from "./ui";

async function loadDevices(locale: string) {
  const token = (await cookies()).get("mindpal_token")?.value ?? "";
  const q = new URLSearchParams();
  q.set("limit", "50");
  q.set("offset", "0");
  q.set("ownerScope", "space");
  const res = await apiFetch(`/devices?${q.toString()}`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovDevicesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadDevices(locale);
  return <GovDevicesClient locale={locale} initial={initial} />;
}

