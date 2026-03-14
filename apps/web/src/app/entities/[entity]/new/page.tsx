import Link from "next/link";
import { cookies } from "next/headers";
import { API_BASE, apiHeaders, pickLocale, text } from "../../../../lib/api";
import { EntityForm } from "./ui";
import { t } from "../../../../lib/i18n";
import type { EffectiveSchema, SearchParams } from "../../../../lib/types";

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

export default async function EntityNewPage(props: {
  params: { entity: string };
  searchParams: SearchParams | Promise<SearchParams>;
}) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const entity = decodeURIComponent(props.params.entity);
  const schema = await loadEffectiveSchema(locale, entity);
  const title = text(schema?.displayName ?? entity, locale) || entity;

  return (
    <main style={{ padding: 24 }}>
      <p>
        <Link href={`/entities/${encodeURIComponent(entity)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "back")}</Link>
      </p>
      <h1>
        {t(locale, "create.prefix")}
        {title}
      </h1>
      <EntityForm locale={locale} entity={entity} schema={schema} />
    </main>
  );
}
