"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import {
  type RecentEntry, type FavoriteEntry,
  loadRecent, clearRecent, loadFavorites, addFavorite, removeFavorite,
} from "@/app/homeHelpers";
import styles from "./RecentAndFavorites.module.css";

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconStar(props: { filled?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={props.filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function IconPage() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconWorkbench() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/* ─── Utility Functions ─────────────────────────────────────────────────────── */

function getUrl(kind: string, name: string, locale: string): string {
  if (kind === "page") return `/pages/${encodeURIComponent(name)}?lang=${encodeURIComponent(locale)}`;
  if (kind === "workbench") return `/workbench/${encodeURIComponent(name)}?lang=${encodeURIComponent(locale)}`;
  return `/?lang=${encodeURIComponent(locale)}`;
}

function timeAgo(ts: number, locale: string): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return t(locale, "recentFav.justNow");
  if (diffMin < 60) return t(locale, "recentFav.minutesAgo").replace("{n}", String(diffMin));
  if (diffHr < 24) return t(locale, "recentFav.hoursAgo").replace("{n}", String(diffHr));
  if (diffDay < 7) return t(locale, "recentFav.daysAgo").replace("{n}", String(diffDay));
  return new Date(ts).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
}

/* ─── Item Component ────────────────────────────────────────────────────────── */

function ListItem(props: {
  kind: string;
  name: string;
  url: string;
  ts?: number;
  isFavorite: boolean;
  locale: string;
  onToggleFavorite: (kind: string, name: string, url: string) => void;
  onOpen?: (kind: string, name: string, url: string) => void;
}) {
  const { kind, name, url, ts, isFavorite: fav, locale, onToggleFavorite, onOpen } = props;

  const handleClick = (e: React.MouseEvent) => {
    if (onOpen) {
      e.preventDefault();
      onOpen(kind, name, url);
    }
  };

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleFavorite(kind, name, url);
  };

  return (
    <Link href={url} className={styles.item} onClick={handleClick}>
      <span className={styles.itemIcon}>
        {kind === "page" ? <IconPage /> : <IconWorkbench />}
      </span>
      <div className={styles.itemContent}>
        <span className={styles.itemName}>{name}</span>
        {ts && <span className={styles.itemTime}>{timeAgo(ts, locale)}</span>}
      </div>
      <button
        className={`${styles.favoriteBtn} ${fav ? styles.favoriteBtnActive : ""}`}
        onClick={handleFavoriteClick}
        title={fav ? t(locale, "recentFav.removeFavorite") : t(locale, "recentFav.addFavorite")}
      >
        <IconStar filled={fav} />
      </button>
      <span className={styles.itemArrow}><IconChevronRight /></span>
    </Link>
  );
}

/* ─── Main RecentAndFavorites Component ─────────────────────────────────────── */

export default function RecentAndFavorites(props: {
  locale: string;
  onOpen?: (kind: string, name: string, url: string) => void;
  collapsed?: boolean;
}) {
  const { locale, onOpen, collapsed } = props;
  const [tab, setTab] = useState<"recent" | "favorites">("recent");
  
  // Use lazy initialization to load from localStorage
  const [recent, setRecent] = useState<RecentEntry[]>(() => {
    if (typeof window === "undefined") return [];
    return loadRecent();
  });
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => {
    if (typeof window === "undefined") return [];
    return loadFavorites();
  });

  const handleToggleFavorite = useCallback((kind: string, name: string, url: string) => {
    const isFav = favorites.some((f) => f.kind === kind && f.name === name);
    if (isFav) {
      const updated = removeFavorite(kind, name);
      setFavorites(updated);
    } else {
      const updated = addFavorite({ kind: kind as FavoriteEntry["kind"], name, url });
      setFavorites(updated);
    }
  }, [favorites]);

  const handleClearRecent = useCallback(() => {
    clearRecent();
    setRecent([]);
  }, []);

  const isFav = useCallback((kind: string, name: string) => {
    return favorites.some((f) => f.kind === kind && f.name === name);
  }, [favorites]);

  if (collapsed) return null;

  const hasRecent = recent.length > 0;
  const hasFavorites = favorites.length > 0;

  if (!hasRecent && !hasFavorites) return null;

  return (
    <div className={styles.container}>
      {/* Tab Header */}
      <div className={styles.header}>
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === "recent" ? styles.tabActive : ""}`}
            onClick={() => setTab("recent")}
          >
            {t(locale, "recentFav.recentTab")}
            {hasRecent && <span className={styles.tabCount}>{recent.length}</span>}
          </button>
          <button
            className={`${styles.tab} ${tab === "favorites" ? styles.tabActive : ""}`}
            onClick={() => setTab("favorites")}
          >
            <IconStar filled />
            {t(locale, "recentFav.favoritesTab")}
            {hasFavorites && <span className={styles.tabCount}>{favorites.length}</span>}
          </button>
        </div>
        {tab === "recent" && hasRecent && (
          <button className={styles.clearBtn} onClick={handleClearRecent}>
            {t(locale, "recentFav.clear")}
          </button>
        )}
      </div>

      {/* Content */}
      <div className={styles.content}>
        {tab === "recent" && (
          <>
            {!hasRecent && (
              <div className={styles.emptyState}>{t(locale, "recentFav.noRecent")}</div>
            )}
            {hasRecent && (
              <div className={styles.list}>
                {recent.slice(0, 8).map((r, i) => (
                  <ListItem
                    key={`${r.kind}_${r.name}_${i}`}
                    kind={r.kind}
                    name={r.name}
                    url={r.url ?? getUrl(r.kind, r.name, locale)}
                    ts={r.ts}
                    isFavorite={isFav(r.kind, r.name)}
                    locale={locale}
                    onToggleFavorite={handleToggleFavorite}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === "favorites" && (
          <>
            {!hasFavorites && (
              <div className={styles.emptyState}>{t(locale, "recentFav.noFavorites")}</div>
            )}
            {hasFavorites && (
              <div className={styles.list}>
                {favorites.map((f, i) => (
                  <ListItem
                    key={`${f.kind}_${f.name}_${i}`}
                    kind={f.kind}
                    name={f.name}
                    url={f.url}
                    isFavorite={true}
                    locale={locale}
                    onToggleFavorite={handleToggleFavorite}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
