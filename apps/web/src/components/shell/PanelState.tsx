"use client";
import React from "react";
import styles from "./bottomTray.shared.module.css";
import { t } from "@/lib/i18n";

interface PanelLoadingProps {
  message?: string;
  locale?: string;
}

interface PanelErrorProps {
  message: string;
  onRetry?: () => void;
  locale?: string;
}

interface PanelEmptyProps {
  message?: string;
  locale?: string;
}

export function PanelLoading({ message, locale = "zh-CN" }: PanelLoadingProps) {
  return (
    <div className={styles.panelLoading}>
      <span className={styles.spinner} />
      <span>{message ?? t(locale, "common.loading")}</span>
    </div>
  );
}

export function PanelError({ message, onRetry, locale = "zh-CN" }: PanelErrorProps) {
  return (
    <div className={styles.panelError}>
      <span>{message}</span>
      {onRetry && (
        <button className={styles.retryBtn} onClick={onRetry}>
          {t(locale, "common.retry")}
        </button>
      )}
    </div>
  );
}

export function PanelEmpty({ message, locale = "zh-CN" }: PanelEmptyProps) {
  return (
    <div className={styles.panelEmpty}>
      <span>{message ?? t(locale, "common.noItems")}</span>
    </div>
  );
}
