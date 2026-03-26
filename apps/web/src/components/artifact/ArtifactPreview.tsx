"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { t } from "@/lib/i18n";
import { safeJsonString } from "@/lib/apiError";
import styles from "./ArtifactPreview.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

export type ArtifactType = "json" | "table" | "chart" | "markdown" | "file" | "text";

export interface ArtifactPreviewProps {
  type: ArtifactType;
  data: unknown;
  title?: string;
  locale: string;
}

/* ─── JSON Preview ──────────────────────────────────────────────────────────── */

function JsonPreview({ data, locale }: { data: unknown; locale: string }) {
  const formatted = useMemo(() => {
    try {
      if (typeof data === "string") {
        // Try to parse if it's a JSON string
        const parsed = JSON.parse(data);
        return JSON.stringify(parsed, null, 2);
      }
      return JSON.stringify(data, null, 2);
    } catch {
      return safeJsonString(data);
    }
  }, [data]);

  const lines = formatted.split("\n");
  const lineCount = lines.length;

  return (
    <div className={styles.jsonPreview}>
      <div className={styles.jsonHeader}>
        <span className={styles.jsonBadge}>JSON</span>
        <span className={styles.jsonMeta}>{t(locale, "artifact.lineCount").replace("{count}", String(lineCount))}</span>
      </div>
      <div className={styles.jsonContent}>
        <div className={styles.jsonLineNumbers}>
          {lines.map((_, i) => (
            <span key={i} className={styles.jsonLineNumber}>{i + 1}</span>
          ))}
        </div>
        <pre className={styles.jsonCode}>{formatted}</pre>
      </div>
    </div>
  );
}

/* ─── Table Preview ─────────────────────────────────────────────────────────── */

function TablePreview({ data, locale }: { data: unknown; locale: string }) {
  const { headers, rows } = useMemo(() => {
    if (!data) return { headers: [], rows: [] };

    // Handle array of objects
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      const firstRow = data[0] as Record<string, unknown>;
      const headers = Object.keys(firstRow);
      const rows = data.map((row) => {
        const r = row as Record<string, unknown>;
        return headers.map((h) => String(r[h] ?? ""));
      });
      return { headers, rows };
    }

    // Handle 2D array
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
      const firstRow = data[0] as unknown[];
      const headers = firstRow.map((_, i) => `Column ${i + 1}`);
      const rows = data.map((row) => (row as unknown[]).map((cell) => String(cell ?? "")));
      return { headers, rows };
    }

    return { headers: [], rows: [] };
  }, [data]);

  if (headers.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span>{t(locale, "artifact.noTableData")}</span>
      </div>
    );
  }

  return (
    <div className={styles.tablePreview}>
      <div className={styles.tableHeader}>
        <span className={styles.tableBadge}>TABLE</span>
        <span className={styles.tableMeta}>{t(locale, "artifact.rowCount").replace("{count}", String(rows.length))}</span>
      </div>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Chart Preview ─────────────────────────────────────────────────────────── */

function ChartPreview({ data, locale }: { data: unknown; locale: string }) {
  const chartData = useMemo(() => {
    if (!data || typeof data !== "object") return null;
    // Expect data to be { labels: string[], values: number[] } or similar
    const d = data as Record<string, unknown>;
    const labels = Array.isArray(d.labels) ? d.labels : [];
    const values = Array.isArray(d.values) ? d.values.map(Number) : [];
    if (labels.length === 0 || values.length === 0) return null;
    const maxValue = Math.max(...values, 1);
    return { labels, values, maxValue };
  }, [data]);

  if (!chartData) {
    return (
      <div className={styles.emptyState}>
        <span>{t(locale, "artifact.noChartData")}</span>
      </div>
    );
  }

  const { labels, values, maxValue } = chartData;

  return (
    <div className={styles.chartPreview}>
      <div className={styles.chartHeader}>
        <span className={styles.chartBadge}>CHART</span>
        <span className={styles.chartMeta}>{labels.length} {t(locale, "artifact.dataPoints")}</span>
      </div>
      <div className={styles.chartBars}>
        {labels.map((label, i) => (
          <div key={i} className={styles.chartBarGroup}>
            <div className={styles.chartBarLabel}>{String(label)}</div>
            <div className={styles.chartBarTrack}>
              <div
                className={styles.chartBar}
                style={{ width: `${(values[i] / maxValue) * 100}%` }}
              />
            </div>
            <div className={styles.chartBarValue}>{values[i]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Markdown Preview ──────────────────────────────────────────────────────── */

function MarkdownPreview({ data, locale }: { data: unknown; locale: string }) {
  const content = typeof data === "string" ? data : "";

  if (!content) {
    return (
      <div className={styles.emptyState}>
        <span>{t(locale, "artifact.noContent")}</span>
      </div>
    );
  }

  return (
    <div className={styles.markdownPreview}>
      <div className={styles.markdownHeader}>
        <span className={styles.markdownBadge}>MARKDOWN</span>
      </div>
      <div className={styles.markdownContent}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

/* ─── Text/File Preview ─────────────────────────────────────────────────────── */

function TextPreview({ data, locale }: { data: unknown; locale: string }) {
  const content = typeof data === "string" ? data : safeJsonString(data);
  const lineCount = content.split("\n").length;

  return (
    <div className={styles.textPreview}>
      <div className={styles.textHeader}>
        <span className={styles.textBadge}>TEXT</span>
        <span className={styles.textMeta}>{t(locale, "artifact.lineCount").replace("{count}", String(lineCount))}</span>
      </div>
      <pre className={styles.textContent}>{content}</pre>
    </div>
  );
}

/* ─── Main Component ────────────────────────────────────────────────────────── */

export default function ArtifactPreview({ type, data, title, locale }: ArtifactPreviewProps) {
  const renderPreview = () => {
    switch (type) {
      case "json":
        return <JsonPreview data={data} locale={locale} />;
      case "table":
        return <TablePreview data={data} locale={locale} />;
      case "chart":
        return <ChartPreview data={data} locale={locale} />;
      case "markdown":
        return <MarkdownPreview data={data} locale={locale} />;
      case "file":
      case "text":
      default:
        return <TextPreview data={data} locale={locale} />;
    }
  };

  return (
    <div className={styles.artifactPreview}>
      {title && (
        <div className={styles.previewTitle}>{title}</div>
      )}
      {renderPreview()}
    </div>
  );
}
