"use client";

import { Suspense, lazy } from "react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import { type FlowNl2UiResult, type WorkspaceTab } from "../../app/homeHelpers";
import { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";
import { IconPanel } from "../../app/HomeIcons";
import styles from "../../app/page.module.css";

const DynamicBlockRenderer = lazy(() => import("@/components/nl2ui/DynamicBlockRenderer"));

export function FlowNl2uiResult({ locale, it, savedPages, savingPageId, openInWorkspace, saveAsPage, setMaximizedNl2ui }: {
  locale: string;
  it: FlowNl2UiResult;
  savedPages: Record<string, { pageName: string; pageUrl: string }>;
  savingPageId: string | null;
  openInWorkspace: (tab: { kind: WorkspaceTab["kind"]; name: string; url: string; meta?: WorkspaceTab["meta"] }) => void;
  saveAsPage: (flowItemId: string, config: Nl2UiConfig, userInput: string) => void;
  setMaximizedNl2ui: (item: FlowNl2UiResult | null) => void;
}) {
  return (
    <div className={styles.nl2uiResultCard}>
      <div className={styles.nl2uiMeta}>
        <span className={styles.badge}>{t(locale, "nl2ui.confidence")} {it.config.metadata?.confidence ?? "-"}</span>
        <button className={styles.nl2uiMaximizeBtn} onClick={() => setMaximizedNl2ui(it)} title={t(locale, "nl2ui.maximize")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
          {" "}{t(locale, "nl2ui.maximize")}
        </button>
      </div>
      <div className={styles.nl2uiPreview}>
        <Suspense fallback={<div style={{ padding: 16, color: "var(--sl-muted)" }}>{t(locale, "nl2ui.generating")}</div>}>
          <DynamicBlockRenderer config={it.config} readOnly={!it.config.dataBindings?.length} locale={locale} />
        </Suspense>
      </div>
      <div className={styles.nl2uiSuggestions}>
        <button
          className={styles.suggestChip}
          onClick={() => openInWorkspace({
            kind: "nl2uiPreview",
            name: it.userInput.slice(0, 30) || t(locale, "nl2ui.preview"),
            url: "",
            meta: { nl2uiConfig: it.config }
          })}
        >
          <IconPanel /> {t(locale, "nl2ui.openInWorkspace")}
        </button>
        {savedPages[it.id] ? (
          <Link
            className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
            href={`${savedPages[it.id].pageUrl}?lang=${encodeURIComponent(locale)}`}
          >
            {t(locale, "nl2ui.savedOpen")}
          </Link>
        ) : (
          <button
            className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
            onClick={() => void saveAsPage(it.id, it.config, it.userInput)}
            disabled={savingPageId === it.id}
          >
            {savingPageId === it.id ? t(locale, "nl2ui.saving") : t(locale, "nl2ui.saveAsPage")}
          </button>
        )}
      </div>
    </div>
  );
}
