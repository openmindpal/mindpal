import { ConsoleShell } from "@/components/shell/ConsoleShell";
import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import AdminWorkbenchesClient from "./ui";

async function loadWorkbenches(locale: string) {
  const token = (await cookies()).get("mindpal_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/workbenches`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function AdminWorkbenchesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await props.searchParams;
  const locale = pickLocale(searchParams);
  const initial = await loadWorkbenches(locale);
  return (
    <ConsoleShell locale={locale}>
      <AdminWorkbenchesClient locale={locale} initial={initial.json} initialStatus={initial.status} />
    </ConsoleShell>
  );
}

