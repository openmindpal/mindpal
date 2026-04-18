"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import {
  type RecentEntry, type FavoriteEntry,
  loadRecent, clearRecent, loadFavorites, addFavorite, removeFavorite,
} from "@/app/homeHelpers";
import { IconStar, IconPage, IconWorkbench, IconChevronRight } from "./ShellIcons";
import { timeAgoFromTs } from "./shellUtils";
import styles from "./RecentAndFavorites.module.css";

/* ─── Utility Functions ─────────────────────────────────────────────────────── */

function getUrl(kind: string, name: string, locale: string): string {
  if (kind === "page") return `/pages/${encodeURIComponent(name)}?lang=${encodeURIComponent(locale)}`;
  if (kind === "workbench") return `/workbench/${encodeURIComponent(name)}?lang=${encodeURIComponent(locale)}`;
  return `/?lang=${encodeURIComponent(locale)}`;
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
        {ts && <span className={styles.itemTime}>{timeAgoFromTs(ts, locale, "recentFav")}</span>}
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
}) {
  const { locale, onOpen } = props;
  const [tab, setTab] = useState<"recent" | "favorites">("recent");
  
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  useEffect(() => {
    setRecent(loadRecent());
    setFavorites(loadFavorites());
  }, []);

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
