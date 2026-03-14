import Link from "next/link";
import { cookies } from "next/headers";
import styles from "./page.module.css";
import { API_BASE, apiHeaders, pickLocale, text } from "../lib/api";
import { t } from "../lib/i18n";
import type { SearchParams, UiNavItem, UiNavigation } from "../lib/types";

async function loadNavigation(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/ui/navigation`, {
    method: "GET",
    headers: apiHeaders(locale, { token }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown as UiNavigation;
}

export default async function Home(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const nav = await loadNavigation(locale);
  const items = nav?.items ?? [];
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.intro}>
          <h1>{t(locale, "app.title")}</h1>
          <p>
            {t(locale, "lang.label")}
            <Link href={`/?lang=zh-CN`}>{t(locale, "lang.zh")}</Link> | <Link href={`/?lang=en-US`}>{t(locale, "lang.en")}</Link>
          </p>
          <p>
            <Link href={`/settings?lang=${encodeURIComponent(locale)}`}>{t(locale, "home.settings")}</Link>
            {" "}
            | <Link href={`/admin/ui?lang=${encodeURIComponent(locale)}`}>{t(locale, "home.adminUi")}</Link> |{" "}
            <Link href={`/admin/rbac?lang=${encodeURIComponent(locale)}`}>{t(locale, "home.adminRbac")}</Link> |{" "}
            <Link href={`/gov/changesets?lang=${encodeURIComponent(locale)}`}>{t(locale, "home.governanceConsole")}</Link>
          </p>
          <p>
            {t(locale, "nav.label")}
            {items.length ? `${items.length} ${t(locale, "nav.items")}` : t(locale, "nav.notLoaded")}
          </p>
        </div>
        <div className={styles.ctas}>
          {items.map((it: UiNavItem) => (
            <Link
              key={it.name}
              className={styles.primary}
              href={`${it.href}?lang=${encodeURIComponent(locale)}`}
            >
              {text(it.title ?? it.name, locale) || it.name}
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
