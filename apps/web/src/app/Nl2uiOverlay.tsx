"use client";

import { Suspense, lazy } from "react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";
import type { FlowNl2UiResult } from "./homeHelpers";
import { IconMinimize } from "./HomeIcons";
import styles from "@/styles/page.module.css";

const DynamicBlockRenderer = lazy(() => import("@/components/nl2ui/DynamicBlockRenderer"));

export interface Nl2uiOverlayProps {
  locale: string;
  maximizedNl2ui: FlowNl2UiResult;
  savedPages: Record<string, { pageName: string; pageUrl: string }>;
  savingPageId: string | null;
  saveAsPage: (flowItemId: string, config: Nl2UiConfig, userInput: string) => void;
  setMaximizedNl2ui: (item: FlowNl2UiResult | null) => void;
  handleCardClick: (card: { title: string; id?: string; [key: string]: any }) => void;
}

export default function Nl2uiOverlay(props: Nl2uiOverlayProps) {
  const { locale, maximizedNl2ui, savedPages, savingPageId, saveAsPage, setMaximizedNl2ui, handleCardClick } = props;

  return (
    <div className={styles.nl2uiOverlay}>
      <div className={styles.nl2uiOverlayHeader}>
        <div className={styles.nl2uiOverlayMeta}>
          <span className={styles.badge}>{t(locale, "nl2ui.confidence")} {maximizedNl2ui.config.metadata?.confidence ?? "-"}</span>
        </div>
        <div className={styles.nl2uiOverlayActions}>
          {savedPages[maximizedNl2ui.id] ? (
            <Link
              className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
              href={`${savedPages[maximizedNl2ui.id].pageUrl}?lang=${encodeURIComponent(locale)}`}
            >
              {t(locale, "nl2ui.savedOpen")}
            </Link>
          ) : (
            <button
              className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
              onClick={() => void saveAsPage(maximizedNl2ui.id, maximizedNl2ui.config, maximizedNl2ui.userInput)}
              disabled={savingPageId === maximizedNl2ui.id}
            >
              {savingPageId === maximizedNl2ui.id ? t(locale, "nl2ui.saving") : t(locale, "nl2ui.saveAsPage")}
            </button>
          )}
          <button
            className={styles.nl2uiOverlayCloseBtn}
            onClick={() => setMaximizedNl2ui(null)}
            title={t(locale, "nl2ui.restore")}
          >
            <IconMinimize /> {t(locale, "nl2ui.restore")}
          </button>
        </div>
      </div>
      <div className={styles.nl2uiOverlayBody}>
        <Suspense fallback={<div style={{ padding: 16, color: "var(--sl-muted)" }}>{t(locale, "nl2ui.generating")}</div>}>
          <DynamicBlockRenderer
            config={maximizedNl2ui.config}
            readOnly={!maximizedNl2ui.config.dataBindings?.length}
            locale={locale}
            enableLayoutEdit={true}
            onCardClick={(card) => { setMaximizedNl2ui(null); handleCardClick(card); }}
          />
        </Suspense>
      </div>
    </div>
  );
}
