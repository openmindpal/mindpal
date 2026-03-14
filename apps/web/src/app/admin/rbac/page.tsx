import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import AdminRbacClient from "./ui";
import type { SearchParams } from "@/lib/types";

export default async function AdminRbacPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const headers = apiHeaders(locale);

  const [rolesRes, permsRes] = await Promise.all([
    fetch(`${API_BASE}/rbac/roles?limit=200`, { headers, cache: "no-store" }),
    fetch(`${API_BASE}/rbac/permissions?limit=500`, { headers, cache: "no-store" }),
  ]);

  const rolesJson = rolesRes.ok ? await rolesRes.json() : await rolesRes.json().catch(() => null);
  const permsJson = permsRes.ok ? await permsRes.json() : await permsRes.json().catch(() => null);

  return (
    <ConsoleShell locale={locale}>
      <AdminRbacClient
        locale={locale}
        initial={{ roles: rolesJson, permissions: permsJson, rolesStatus: rolesRes.status, permissionsStatus: permsRes.status }}
      />
    </ConsoleShell>
  );
}
