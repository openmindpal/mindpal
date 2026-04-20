"use client";

import Link from "next/link";
import { type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { t } from "@/lib/i18n";
import { AppShell, AppShellContent, AppShellHeader, AppShellSideNav } from "./AppShell";
import { CommandPalette, useCommandPaletteShortcut, type CommandItem } from "./CommandPalette";
import { NAV_CONFIG, EXTRA_PALETTE_ITEMS, type NavSubGroupConfig } from "./navConfig";
import styles from "./ConsoleShell.module.css";

const NAV_VISITS_KEY = "openslin_nav_visits";
const MAX_RECENT_NAV = 5;

function parseKeywords(locale: string, key: string): string[] {
  const raw = t(locale, key);
  return raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build href with ?lang= query param */
function buildHref(path: string, locale: string): string {
  return `${path}?lang=${encodeURIComponent(locale)}`;
}

/* ─── Nav link with hover description ─── */

function NavLink(props: { href: string; label: string; desc?: string; pathname?: string }) {
  const hrefPath = props.href.split("?")[0];
  const isActive = props.pathname === hrefPath;
  const cls = isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink;
  return (
    <Link className={cls} href={props.href}>
      {props.label}
      {props.desc ? <div className={styles.navLinkDesc}>{props.desc}</div> : null}
    </Link>
  );
}

/* ─── Collapsible sub-group ─── */

const SUBGROUP_STORAGE_KEY = "openslin_nav_subgroups";

function NavSubGroup(props: { groupKey: string; label: string; defaultOpen?: boolean; forceOpen?: boolean; children: ReactNode }) {
  const defaultValue = props.forceOpen ? true : (props.defaultOpen ?? false);
  const [open, setOpen] = useState(defaultValue);

  // Sync the expanded state from localStorage after hydration to avoid SSR mismatch.
  useEffect(() => {
    if (props.forceOpen) return;
    const timer = setTimeout(() => {
      try {
        const raw = localStorage.getItem(SUBGROUP_STORAGE_KEY);
        if (raw) {
          const map: Record<string, boolean> = JSON.parse(raw);
          if (typeof map[props.groupKey] === "boolean") {
            setOpen(map[props.groupKey]);
          }
        }
      } catch { /* ignore */ }
    }, 0);
    return () => clearTimeout(timer);
  }, [props.groupKey, props.forceOpen]);

  const toggle = useCallback(() => {
    if (props.forceOpen) return;
    setOpen((prev) => {
      const next = !prev;
      try {
        const raw = localStorage.getItem(SUBGROUP_STORAGE_KEY);
        const map: Record<string, boolean> = raw ? JSON.parse(raw) : {};
        map[props.groupKey] = next;
        localStorage.setItem(SUBGROUP_STORAGE_KEY, JSON.stringify(map));
      } catch { /* ignore */ }
      return next;
    });
  }, [props.groupKey, props.forceOpen]);

  const effectiveOpen = props.forceOpen ? true : open;

  return (
    <div className={`${styles.navSubGroup} ${effectiveOpen ? styles.navSubGroupOpen : ""}`}>
      <button className={styles.navSubGroupToggle} onClick={toggle} type="button" disabled={!!props.forceOpen}>
        <span>{props.label}</span>
        <span className={styles.navSubGroupArrow}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </span>
      </button>
      <ul className={styles.navSubGroupBody}>
        {props.children}
      </ul>
    </div>
  );
}

function RecentNavSection(props: { items: CommandItem[]; locale: string; pathname: string }) {
  const [recentHrefs, setRecentHrefs] = useState<string[]>([]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const raw = localStorage.getItem(NAV_VISITS_KEY);
      if (!raw) return;
      const visits: Record<string, number> = JSON.parse(raw);
      const sorted = Object.entries(visits)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_RECENT_NAV)
        .map(([href]) => href);
      timer = setTimeout(() => setRecentHrefs(sorted), 0);
    } catch { /* ignore */ }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  const recentItems = recentHrefs
    .map((href) => props.items.find((i) => i.href === href))
    .filter(Boolean) as CommandItem[];

  if (recentItems.length === 0) return null;
  const label = t(props.locale, "recentNav.titleCaps");
  return (
    <div className={styles.navGroup}>
      <div className={styles.navGroupTitle}>{label}</div>
      <ul className={styles.navList}>
        {recentItems.map((item) => (
          <li key={item.id}>
            <NavLink href={item.href} label={item.label} pathname={props.pathname} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Check if any item in a sub-group matches the current pathname */
function isSubGroupActive(subGroup: NavSubGroupConfig, pathname: string): boolean {
  return subGroup.items.some((item) => pathname.startsWith(item.path));
}

function ConsoleShellInner(props: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const locale = searchParams.get("lang") || "zh-CN";

  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  useCommandPaletteShortcut(openPalette);

  /* ─── Generate paletteItems from config (memoized, Task #4) ─── */
  const paletteItems: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [];

    // Extra palette-only items (home, docs)
    for (const item of EXTRA_PALETTE_ITEMS) {
      items.push({
        id: item.id,
        label: t(locale, item.labelKey),
        group: t(locale, "shell.nav.console"),
        href: buildHref(item.path, locale),
        keywords: item.keywordsKey ? parseKeywords(locale, item.keywordsKey) : [],
      });
    }

    // Items from NAV_CONFIG
    for (const group of NAV_CONFIG) {
      const groupLabel = t(locale, group.labelKey);
      if (group.items) {
        for (const item of group.items) {
          items.push({
            id: item.id,
            label: t(locale, item.labelKey),
            group: groupLabel,
            href: buildHref(item.path, locale),
            keywords: item.keywordsKey ? parseKeywords(locale, item.keywordsKey) : [],
          });
        }
      }
      if (group.subGroups) {
        for (const sub of group.subGroups) {
          for (const item of sub.items) {
            items.push({
              id: item.id,
              label: t(locale, item.labelKey),
              group: groupLabel,
              href: buildHref(item.path, locale),
              keywords: item.keywordsKey ? parseKeywords(locale, item.keywordsKey) : [],
            });
          }
        }
      }
    }

    return items;
  }, [locale]);

  /* ─── Helpers for rendering ─── */
  const homeHref = buildHref("/", locale);
  const docsHref = buildHref("/docs", locale);

  return (
    <AppShell
      header={
        <AppShellHeader>
          <div className={styles.headerRow}>
            <div className={styles.headerLeft}>
              <Link className={styles.appTitle} href={homeHref}>
                {t(locale, "app.title")}
              </Link>
            </div>
            <div className={styles.headerRight}>
              <details className={styles.mobileMenu}>
                <summary>{t(locale, "shell.nav.menu")}</summary>
                <div className={styles.mobileMenuPanel}>
                  {NAV_CONFIG.map((group) => {
                    if (group.items) {
                      return group.items.map((item) => (
                        <Link key={item.id} href={buildHref(item.path, locale)}>{t(locale, item.labelKey)}</Link>
                      ));
                    }
                    if (group.subGroups) {
                      return group.subGroups.map((sub) =>
                        sub.items.map((item) => (
                          <Link key={item.id} href={buildHref(item.path, locale)}>{t(locale, item.labelKey)}</Link>
                        ))
                      );
                    }
                    return null;
                  })}
                </div>
              </details>
              <Link href={docsHref}>{t(locale, "shell.nav.docs")}</Link>
              <button className={styles.paletteBtn} onClick={openPalette} type="button" title="Ctrl+K">
                {t(locale, "cmdPalette.openButton")}
                <span className={styles.paletteBtnKbd}>⌘K</span>
              </button>
            </div>
          </div>
        </AppShellHeader>
      }
      sideNav={
        <AppShellSideNav>
          <RecentNavSection items={paletteItems} locale={locale} pathname={pathname} />

          {NAV_CONFIG.map((group) => (
            <div key={group.id} className={styles.navGroup}>
              <div className={styles.navGroupTitle}>{t(locale, group.labelKey)}</div>

              {/* Direct items (console group) */}
              {group.items && (
                <ul className={styles.navList}>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <NavLink
                        href={buildHref(item.path, locale)}
                        label={t(locale, item.labelKey)}
                        desc={item.descKey ? t(locale, item.descKey) : undefined}
                        pathname={pathname}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {/* Sub-groups (governance, admin) */}
              {group.subGroups?.map((sub) => (
                <NavSubGroup
                  key={sub.groupKey}
                  groupKey={sub.groupKey}
                  label={t(locale, sub.labelKey)}
                  defaultOpen={sub.defaultOpen}
                  forceOpen={isSubGroupActive(sub, pathname)}
                >
                  {sub.items.map((item) => (
                    <li key={item.id}>
                      <NavLink
                        href={buildHref(item.path, locale)}
                        label={t(locale, item.labelKey)}
                        desc={item.descKey ? t(locale, item.descKey) : undefined}
                        pathname={pathname}
                      />
                    </li>
                  ))}
                </NavSubGroup>
              ))}
            </div>
          ))}

        </AppShellSideNav>
      }
    >
      <AppShellContent>{props.children}</AppShellContent>
      <CommandPalette items={paletteItems} locale={locale} open={paletteOpen} onClose={closePalette} />
    </AppShell>
  );
}

export function ConsoleShell(props: { locale?: string; children: ReactNode }) {
  return (
    <Suspense>
      <ConsoleShellInner>{props.children}</ConsoleShellInner>
    </Suspense>
  );
}
