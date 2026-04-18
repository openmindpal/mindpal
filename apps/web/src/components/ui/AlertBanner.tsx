"use client";

import { useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";

/* ─── Types ────────────────────────────────────────────── */

export type AlertSeverity = "error" | "warning" | "success" | "info";

export interface AlertBannerProps {
  severity?: AlertSeverity;
  /** Main user-visible message */
  children: ReactNode;
  /** Raw technical details (shown in collapsible panel) */
  technical?: string;
  /** Recovery suggestion text */
  recovery?: ReactNode;
  /** Locale for toggle label */
  locale?: string;
  /** Dismiss handler – if provided, shows X button */
  onDismiss?: () => void;
  style?: React.CSSProperties;
}

/* ─── Severity config ──────────────────────────────────── */

const SEV: Record<AlertSeverity, { icon: string; bg: string; border: string; fg: string; accent: string }> = {
  error:   { icon: "✕", bg: "#fef2f2", border: "#fecaca", fg: "#991b1b", accent: "#dc2626" },
  warning: { icon: "⚠", bg: "#fffbeb", border: "#fde68a", fg: "#92400e", accent: "#d97706" },
  success: { icon: "✓", bg: "#f0fdf4", border: "#bbf7d0", fg: "#166534", accent: "#16a34a" },
  info:    { icon: "ℹ", bg: "#eff6ff", border: "#bfdbfe", fg: "#1e40af", accent: "#2563eb" },
};

/* ─── Error code → user-friendly message mapping ──────── */

const ERROR_FRIENDLY_KEYS: Record<string, string> = {
  UNAUTHORIZED: "alert.error.UNAUTHORIZED",
  FORBIDDEN: "alert.error.FORBIDDEN",
  NOT_FOUND: "alert.error.NOT_FOUND",
  CONFLICT: "alert.error.CONFLICT",
  RATE_LIMITED: "alert.error.RATE_LIMITED",
  INTERNAL_SERVER_ERROR: "alert.error.INTERNAL_SERVER_ERROR",
  TIMEOUT: "alert.error.TIMEOUT",
  VALIDATION_ERROR: "alert.error.VALIDATION_ERROR",
  CONNECTION_ERROR: "alert.error.CONNECTION_ERROR",
  MODEL_NOT_AVAILABLE: "alert.error.MODEL_NOT_AVAILABLE",
};

/* ─── Recovery suggestion mapping ──────────────────────── */

const RECOVERY_HINT_KEYS: Record<string, string> = {
  UNAUTHORIZED: "alert.recovery.UNAUTHORIZED",
  FORBIDDEN: "alert.recovery.FORBIDDEN",
  NOT_FOUND: "alert.recovery.NOT_FOUND",
  CONFLICT: "alert.recovery.CONFLICT",
  RATE_LIMITED: "alert.recovery.RATE_LIMITED",
  INTERNAL_SERVER_ERROR: "alert.recovery.INTERNAL_SERVER_ERROR",
  TIMEOUT: "alert.recovery.TIMEOUT",
  VALIDATION_ERROR: "alert.recovery.VALIDATION_ERROR",
  CONNECTION_ERROR: "alert.recovery.CONNECTION_ERROR",
  MODEL_NOT_AVAILABLE: "alert.recovery.MODEL_NOT_AVAILABLE",
};

/**
 * Extract error code from error text string.
 * Matches patterns like "UNAUTHORIZED: ...", "ERROR: ...", status codes like "401", "500".
 */
function extractErrorCode(text: string): string | null {
  // Match leading uppercase error code
  const m = text.match(/^([A-Z_]{3,})/);
  if (m) return m[1];
  // Match HTTP status code
  const status = text.match(/\b(401|403|404|409|429|500|502|503|504)\b/);
  if (status) {
    const map: Record<string, string> = {
      "401": "UNAUTHORIZED", "403": "FORBIDDEN", "404": "NOT_FOUND",
      "409": "CONFLICT", "429": "RATE_LIMITED", "500": "INTERNAL_SERVER_ERROR",
      "502": "INTERNAL_SERVER_ERROR", "503": "INTERNAL_SERVER_ERROR", "504": "TIMEOUT",
    };
    return map[status[1]] ?? null;
  }
  return null;
}

/**
 * Get user-friendly error message for a given error text.
 */
export function friendlyError(errorText: string, locale: string): { message: string; recovery: string | null } {
  const code = extractErrorCode(errorText);
  const messageKey = code ? ERROR_FRIENDLY_KEYS[code] : null;
  const recoveryKey = code ? RECOVERY_HINT_KEYS[code] : null;
  if (messageKey) {
    return {
      message: t(locale, messageKey),
      recovery: recoveryKey ? t(locale, recoveryKey) : null,
    };
  }
  return { message: errorText, recovery: null };
}

/* ─── Component ────────────────────────────────────────── */

export function AlertBanner({ severity = "error", children, technical, recovery, locale, onDismiss, style }: AlertBannerProps) {
  const [showTech, setShowTech] = useState(false);
  const s = SEV[severity];

  return (
    <div
      role="alert"
      style={{
        padding: "12px 16px",
        borderRadius: 8,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.fg,
        fontSize: 13,
        lineHeight: 1.6,
        display: "grid",
        gap: 6,
        ...style,
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {/* Icon */}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: s.accent,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          {s.icon}
        </span>
        {/* Message */}
        <div style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{children}</div>
        {/* Dismiss */}
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{
              background: "none",
              border: "none",
              color: s.fg,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              opacity: 0.6,
              padding: 0,
              flexShrink: 0,
            }}
            aria-label="dismiss"
          >
            ×
          </button>
        )}
      </div>

      {/* Recovery suggestion */}
      {recovery && (
        <div style={{ marginLeft: 28, fontSize: 12, color: s.accent, fontWeight: 500 }}>
          {recovery}
        </div>
      )}

      {/* Technical details (collapsible) */}
      {technical && (
        <div style={{ marginLeft: 28 }}>
          <button
            onClick={() => setShowTech(!showTech)}
            style={{
              background: "none",
              border: "none",
              color: s.accent,
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            {showTech ? "▼" : "▶"} {t(locale, "alert.technicalDetails")}
          </button>
          {showTech && (
            <pre
              style={{
                marginTop: 6,
                padding: "8px 12px",
                borderRadius: 6,
                background: "rgba(0,0,0,0.04)",
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {technical}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
