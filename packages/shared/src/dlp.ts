import { isPlainObject, normalizeStringSet } from "./runtime";
import { resolveString } from "./runtimeConfig";

export type DlpHitType = "token" | "email" | "phone" | "idCard" | "creditCard" | "bankAccount" | "address" | "ipAddress";
export type DlpMode = "audit_only" | "deny";
export type DlpPolicyVersion = "v1";

export type DlpPolicy = {
  version: DlpPolicyVersion;
  mode: DlpMode;
  denyTargets: Set<string>;
  denyHitTypes: Set<DlpHitType>;
};

export type DlpSummary = {
  hitCounts: Record<DlpHitType, number>;
  redacted: boolean;
  disposition?: "redact" | "deny";
  mode?: DlpMode;
  policyVersion?: DlpPolicyVersion;
};

/**
 * Luhn 算法校验（用于信用卡、银行卡号验证）
 */
function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * 中国居民身份证校验位验证（GB 11643-1999）
 */
function isValidChineseIdCard(id: string): boolean {
  if (id.length !== 18) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const d = parseInt(id[i], 10);
    if (isNaN(d)) return false;
    sum += d * weights[i];
  }
  return checkCodes[sum % 11] === id[17].toUpperCase();
}

const rules: Array<{ type: DlpHitType; re: RegExp; validate?: (match: string) => boolean }> = [
  // Token & API Keys
  { type: "token", re: /\bBearer\s+[A-Za-z0-9\-_.=]{10,}\b/gi },
  { type: "token", re: /\bsk[-_][A-Za-z0-9_-]{10,}\b/g }, // Support sk-proj-xxx format
  { type: "token", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "token", re: /\bAIza[0-9A-Za-z\-_]{20,}\b/g },
  
  // Email
  { type: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  
  // Phone Numbers: 恢复\b前缀来避免匹配字符串中间的数字序列
  { type: "phone", re: /(?:^|\s|\b)\+\d{10,15}\b/g },  // 国际号码（必须有+前缀）
  { type: "phone", re: /\b1[3-9]\d{9}\b/g },              // 中国手机号（更精确：1[3-9]开头）
  
  // Chinese ID Card (18 digits with checksum validation)
  { type: "idCard", re: /\b\d{17}[0-9Xx]\b/g, validate: isValidChineseIdCard },
  
  // Credit Card Numbers (带 Luhn 校验)
  { type: "creditCard", re: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g, validate: luhnCheck },
  
  // Bank Account Numbers: 必须通过 Luhn 校验且不与已知信用卡前缀重叠
  { type: "bankAccount", re: /\b[1-9]\d{15,18}\b/g, validate: (m) => {
    // 排除已被 idCard 规则覆盖的18位带校验位的身份证号
    if (m.length === 18 && isValidChineseIdCard(m)) return false;
    // 排除已被 creditCard 规则覆盖的常见卡前缀
    if (/^4[0-9]|^5[1-5]|^3[47]|^6(?:011|5)/.test(m)) return false;
    return luhnCheck(m);
  }},
  
  // IP Addresses: 排除常见内网地址
  { type: "ipAddress", re: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, validate: (ip) => {
    // 排除内网/本地地址，只标记公网IP
    if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("127.")) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return false;
    if (ip === "0.0.0.0" || ip === "255.255.255.255") return false;
    return true;
  }},
];

const FALLBACK_DLP_DENY_TARGETS = "model:invoke,tool:execute";
const FALLBACK_DLP_DENY_HIT_TYPES = "token";

function normalizeDlpMode(value: unknown): DlpMode {
  return value === "deny" ? "deny" : "audit_only";
}

function normalizeDlpHitTypeSet(value: unknown, fallbackCsv: string) {
  const out = new Set<DlpHitType>();
  const src = normalizeStringSet(value, fallbackCsv);
  for (const item of src) {
    if (item === "token" || item === "email" || item === "phone" || 
        item === "idCard" || item === "creditCard" || item === "bankAccount" || 
        item === "address" || item === "ipAddress") {
      out.add(item);
    }
  }
  if (!out.size) out.add("token");
  return out;
}

export function resolveDlpPolicy(input?: { version?: unknown; mode?: unknown; denyTargets?: unknown; denyHitTypes?: unknown }): DlpPolicy {
  return {
    version: input?.version === "v1" ? "v1" : "v1",
    mode: normalizeDlpMode(input?.mode),
    denyTargets: normalizeStringSet(input?.denyTargets, FALLBACK_DLP_DENY_TARGETS),
    denyHitTypes: normalizeDlpHitTypeSet(input?.denyHitTypes, FALLBACK_DLP_DENY_HIT_TYPES),
  };
}

export function resolveDlpPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): DlpPolicy {
  const { value: denyTargets } = resolveString("DLP_DENY_TARGETS", env as Record<string, string | undefined>);
  const { value: denyHitTypes } = resolveString("DLP_DENY_HIT_TYPES", env as Record<string, string | undefined>);
  const { value: mode } = resolveString("DLP_MODE", env as Record<string, string | undefined>);

  return resolveDlpPolicy({
    version: "v1",
    mode,
    denyTargets: denyTargets || FALLBACK_DLP_DENY_TARGETS,
    denyHitTypes: denyHitTypes || FALLBACK_DLP_DENY_HIT_TYPES,
  });
}

export function shouldDenyDlpForTarget(params: { summary: DlpSummary; target: string; policy: DlpPolicy }) {
  if (params.policy.mode !== "deny") return false;
  if (!params.policy.denyTargets.has(params.target)) return false;
  for (const type of params.policy.denyHitTypes) {
    if ((params.summary.hitCounts[type] ?? 0) > 0) return true;
  }
  return false;
}

export function redactString(input: string) {
  let redacted = input;
  const hitCounts: Record<DlpHitType, number> = { 
    token: 0, email: 0, phone: 0, idCard: 0, creditCard: 0, bankAccount: 0, address: 0, ipAddress: 0 
  };
  let changed = false;

  for (const r of rules) {
    const re = new RegExp(r.re.source, r.re.flags);
    if (r.validate) {
      // 带校验函数的规则：逐个匹配并验证
      let matchResult: RegExpExecArray | null;
      const validMatches: string[] = [];
      while ((matchResult = re.exec(redacted)) !== null) {
        if (r.validate(matchResult[0])) {
          validMatches.push(matchResult[0]);
        }
      }
      if (validMatches.length > 0) {
        hitCounts[r.type] += validMatches.length;
        changed = true;
        for (const m of validMatches) {
          redacted = redacted.replace(m, "***REDACTED***");
        }
      }
    } else {
      // 无校验函数的规则：直接匹配
      const matches = redacted.match(re);
      if (matches?.length) {
        hitCounts[r.type] += matches.length;
        changed = true;
        redacted = redacted.replace(re, "***REDACTED***");
      }
    }
  }

  return { value: redacted, summary: { hitCounts, redacted: changed } satisfies DlpSummary };
}

export function redactValue(input: unknown, opts?: { maxDepth?: number; maxStringLen?: number }) {
  const maxDepth = opts?.maxDepth ?? 8;
  const maxStringLen = opts?.maxStringLen ?? 20_000;

  const hitCounts: Record<DlpHitType, number> = { 
    token: 0, email: 0, phone: 0, idCard: 0, creditCard: 0, bankAccount: 0, address: 0, ipAddress: 0 
  };
  let redacted = false;

  function merge(s: DlpSummary) {
    hitCounts.token += s.hitCounts.token;
    hitCounts.email += s.hitCounts.email;
    hitCounts.phone += s.hitCounts.phone;
    hitCounts.idCard += s.hitCounts.idCard;
    hitCounts.creditCard += s.hitCounts.creditCard;
    hitCounts.bankAccount += s.hitCounts.bankAccount;
    hitCounts.address += s.hitCounts.address;
    hitCounts.ipAddress += s.hitCounts.ipAddress;
    redacted = redacted || s.redacted;
  }

  function walk(v: unknown, depth: number): unknown {
    if (typeof v === "string") {
      const clipped = v.length > maxStringLen ? v.slice(0, maxStringLen) : v;
      const r = redactString(clipped);
      merge(r.summary);
      return r.value;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
    if (depth >= maxDepth) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (isPlainObject(v)) {
      const out: any = {};
      for (const [k, vv] of Object.entries(v as any)) out[k] = walk(vv, depth + 1);
      return out;
    }
    return v;
  }

  const value = walk(input, 0);
  return { value, summary: { hitCounts, redacted } satisfies DlpSummary };
}

export function attachDlpSummary(value: unknown, summary: DlpSummary) {
  if (!summary.redacted) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...(value as any), dlpSummary: summary };
  return { value, dlpSummary: summary };
}
