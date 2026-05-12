export function fmtDateTime(date: string | number | Date | unknown, locale: string): string {
  const d = parseDateValue(date);
  if (!d) return "—";
  if (locale === "zh-CN") {
    return `${formatDateParts(d)} ${formatTimeParts24(d)}`;
  }
  return `${formatDatePartsUs(d)}, ${formatTimeParts12(d)}`;
}

export function fmtDate(date: string | number | Date | unknown, locale: string): string {
  const d = parseDateValue(date);
  if (!d) return "—";
  return locale === "zh-CN" ? formatDateParts(d) : formatDatePartsUs(d);
}

export function fmtTime(date: string | number | Date | unknown, locale: string): string {
  const d = parseDateValue(date);
  if (!d) return "—";
  return locale === "zh-CN" ? formatTimeParts24(d) : formatTimeParts12(d);
}

export function fmtShortDateTime(date: string | number | Date | unknown, locale: string): string {
  const d = parseDateValue(date);
  if (!d) return "—";
  if (locale === "zh-CN") {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const hours = d.getHours();
  const hour12 = hours % 12 || 12;
  const meridiem = hours >= 12 ? "PM" : "AM";
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}, ${pad2(hour12)}:${pad2(d.getMinutes())} ${meridiem}`;
}

export function dateValueToMs(value: unknown): number | null {
  const d = parseDateValue(value);
  return d ? d.getTime() : null;
}

export function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const epochMs = Math.abs(value) < 1e11 ? value * 1000 : value;
    const parsed = new Date(epochMs);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseDateValue(Number(trimmed));
  const normalized = normalizeTimestamp(trimmed);
  const parsed = parseNormalizedTimestamp(normalized) ?? new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseNormalizedTimestamp(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, milliRaw, tzRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw ?? 0);
  const minute = Number(minuteRaw ?? 0);
  const second = Number(secondRaw ?? 0);
  const millisecond = Number((milliRaw ?? "").padEnd(3, "0") || 0);
  if (tzRaw) {
    if (tzRaw === "Z") {
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    }
    const sign = tzRaw.startsWith("-") ? -1 : 1;
    const [offsetHourRaw, offsetMinuteRaw] = tzRaw.slice(1).split(":");
    const offsetMinutes = sign * (Number(offsetHourRaw) * 60 + Number(offsetMinuteRaw));
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000;
    return new Date(utcMs);
  }
  return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

function normalizeTimestamp(value: string): string {
  let normalized = value.replace(/\s+/, " ").trim();
  normalized = normalized.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(.*)$/, "$1T$2$3");
  normalized = normalized.replace(/(\.\d{3})\d+/, "$1");
  normalized = normalized.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return normalized;
}

function formatDateParts(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDatePartsUs(date: Date): string {
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()}`;
}

function formatTimeParts24(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatTimeParts12(date: Date): string {
  const hours = date.getHours();
  const hour12 = hours % 12 || 12;
  const meridiem = hours >= 12 ? "PM" : "AM";
  return `${pad2(hour12)}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${meridiem}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
