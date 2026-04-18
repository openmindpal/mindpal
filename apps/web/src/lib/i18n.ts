import enUS from "../locales/en-US.json";
import zhCN from "../locales/zh-CN.json";

export type WebLocale = "zh-CN" | "en-US";

const dicts: Record<WebLocale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function normalizeLocale(locale: string | undefined): WebLocale {
  if (locale === "en-US") return "en-US";
  return "zh-CN";
}

export function t(locale: string | undefined, key: string) {
  const l = normalizeLocale(locale);
  return dicts[l][key] ?? dicts["en-US"][key] ?? dicts["zh-CN"][key] ?? key;
}

/**
 * Translate a raw status string (e.g. "running", "failed") into the user's locale.
 * Falls back to the raw value when no translation key `status.<value>` exists.
 */
export function statusLabel(value: string, locale?: string): string {
  if (!value) return value;
  const key = `status.${value}`;
  const translated = t(locale, key);
  return translated !== key ? translated : value;
}

/**
 * Translate a boolean into 是/否 (or Yes/No) based on locale.
 */
export function boolLabel(value: boolean, locale?: string): string {
  return t(locale, value ? "bool.yes" : "bool.no");
}

