"use client";

import { useState, useCallback } from "react";
import { t } from "@/lib/i18n";
import { API_BASE } from "@/lib/api";
import { type FlowArtifactCard, type WorkspaceTab } from "../../app/homeHelpers";
import { IconPanel } from "../../app/HomeIcons";
import styles from "../../app/page.module.css";

const ARTIFACT_ICONS: Record<string, string> = {
  json: "📊", table: "📊", chart: "📈", markdown: "📄", text: "📄", file: "📦",
};

export function FlowArtifactCard({ it, locale, openInWorkspace }: {
  it: FlowArtifactCard;
  locale: string;
  openInWorkspace: (tab: { kind: WorkspaceTab["kind"]; name: string; url: string; meta?: WorkspaceTab["meta"] }) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const icon = ARTIFACT_ICONS[it.artifactType] ?? "📦";
  const canPreview = it.data != null && ["json", "table", "markdown", "text"].includes(it.artifactType);

  const handleDownload = useCallback(async () => {
    if (it.url) {
      window.open(it.url.startsWith("http") ? it.url : `${API_BASE}${it.url}`, "_blank");
      return;
    }
    if (it.data != null) {
      const ext = it.artifactType === "json" ? ".json" : it.artifactType === "markdown" ? ".md" : it.artifactType === "table" ? ".csv" : ".txt";
      const content = typeof it.data === "string" ? it.data : JSON.stringify(it.data, null, 2);
      const blob = new Blob([content], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${it.title.replace(/[^\w.-]/g, "_")}${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [it]);

  const handlePreview = useCallback(() => {
    openInWorkspace({
      kind: "artifact",
      name: it.title,
      url: it.url || "",
      meta: {
        artifactType: it.artifactType as "json" | "table" | "chart" | "markdown" | "file" | "text",
        artifactData: it.data,
      },
    });
  }, [it, openInWorkspace]);

  return (
    <div className={styles.artifactCard}>
      <div className={styles.artifactCardHeader}>
        <span className={styles.artifactCardIcon}>{icon}</span>
        <div className={styles.artifactCardInfo}>
          <span className={styles.artifactCardTitle}>{it.title}</span>
          <span className={styles.artifactCardType}>{it.artifactType.toUpperCase()}</span>
        </div>
      </div>
      {it.summary && <div className={styles.artifactCardSummary}>{it.summary}</div>}
      <div className={styles.artifactCardActions}>
        {canPreview && (
          <button className={styles.inlineBtn} onClick={handlePreview}>
            <IconPanel /> {t(locale, "artifact.preview")}
          </button>
        )}
        <button className={styles.inlineBtn} onClick={handleDownload} disabled={downloading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          {" "}{t(locale, "artifact.download")}
        </button>
      </div>
    </div>
  );
}
