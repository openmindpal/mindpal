import Link from "next/link";
import { cookies } from "next/headers";
import { API_BASE, apiHeaders, pickLocale, text } from "../../../lib/api";
import { t } from "../../../lib/i18n";
import type { EffectiveSchema, SearchParams } from "../../../lib/types";

async function loadEffectiveSchema(locale: string, entity: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/schemas/${encodeURIComponent(entity)}/effective?schemaName=core`, {
    method: "GET",
    headers: apiHeaders(locale, { token }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown as EffectiveSchema;
}

async function loadEntities(locale: string, entity: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/entities/${encodeURIComponent(entity)}`, {
    method: "GET",
    headers: apiHeaders(locale, { token }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown as { items?: unknown[] };
}

export default async function EntityListPage(props: {
  params: { entity: string };
  searchParams: SearchParams | Promise<SearchParams>;
}) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const entity = decodeURIComponent(props.params.entity);

  const [schema, data] = await Promise.all([loadEffectiveSchema(locale, entity), loadEntities(locale, entity)]);

  const title = text(schema?.displayName ?? entity, locale) || entity;

  return (
    <main style={{ padding: 24 }}>
      <p>
        <Link href={`/?lang=${encodeURIComponent(locale)}`}>{t(locale, "back")}</Link>
      </p>
      <h1>{title}</h1>
      <p>
        <Link href={`/entities/${encodeURIComponent(entity)}/new?lang=${encodeURIComponent(locale)}`}>{t(locale, "create")}</Link>
      </p>

      <pre style={{ background: "rgba(15, 23, 42, 0.03)", padding: 12, overflowX: "auto" }}>
        {JSON.stringify(data, null, 2)}
      </pre>
    </main>
  );
}
