import { normalizeStringSet } from "./runtime";

export type PromptInjectionHitSeverity = "low" | "medium" | "high";
export type PromptInjectionMode = "audit_only" | "deny";
export type PromptInjectionPolicyVersion = "v1";

export type PromptInjectionHit = {
  ruleId: string;
  severity: PromptInjectionHitSeverity;
};

export type PromptInjectionScanResult = {
  hits: PromptInjectionHit[];
  score: number;
  maxSeverity: PromptInjectionHitSeverity | "none";
};

export type PromptInjectionPolicy = {
  version: PromptInjectionPolicyVersion;
  mode: PromptInjectionMode;
  denyTargets: Set<string>;
  denyScore: number;
};

const DEFAULT_PI_DENY_TARGETS = "tool:execute,orchestrator:execute";
const DEFAULT_PI_DENY_SCORE = 6;

/**
 * Unicode 同形字映射表 — 将常见的视觉欺骗字符还原为 ASCII 等价字符
 * 仅覆盖高频攻击字符，不做全量 confusables 转换以免影响性能
 */
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c",
  "\u0443": "y", "\u0445": "x", "\u0455": "s", "\u0456": "i", "\u04BB": "h",
  "\u0501": "d", "\u050D": "g", "\u051B": "q",
  "\uFF41": "a", "\uFF42": "b", "\uFF43": "c", "\uFF44": "d", "\uFF45": "e",
  "\uFF49": "i", "\uFF4C": "l", "\uFF4F": "o", "\uFF50": "p", "\uFF52": "r",
  "\uFF53": "s", "\uFF54": "t", "\uFF55": "u", "\uFF58": "x", "\uFF59": "y",
  "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',
};

/** 零宽字符 / 不可见格式化字符正则（ZWJ / ZWNJ / ZW-Space / BOM / RLO 等） */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

/**
 * 预处理输入文本：移除零宽字符 → 将 Unicode 同形字还原为 ASCII
 * 该函数在 normalizeText 之前执行，确保正则检测无法被同形字绕过
 */
function sanitizeUnicode(text: string): string {
  // 1. 剥离零宽 / 不可见控制字符
  let cleaned = text.replace(ZERO_WIDTH_RE, "");
  // 2. 将已知同形字映射回 ASCII
  cleaned = cleaned.replace(/[^\x00-\x7F]/g, (ch) => CONFUSABLES[ch] ?? ch);
  return cleaned;
}

function normalizeText(text: string) {
  if (text == null) return "";
  const raw = typeof text !== "string" ? String(text) : text;
  return sanitizeUnicode(raw).toLowerCase().replace(/\s+/g, " ").trim();
}

function addHit(hits: PromptInjectionHit[], hit: PromptInjectionHit) {
  if (!hits.some((h) => h.ruleId === hit.ruleId)) hits.push(hit);
}

function severityScore(sev: PromptInjectionHitSeverity) {
  return sev === "high" ? 5 : sev === "medium" ? 2 : 1;
}

function maxSeverityOf(hits: PromptInjectionHit[]): PromptInjectionScanResult["maxSeverity"] {
  if (!hits.length) return "none";
  if (hits.some((h) => h.severity === "high")) return "high";
  if (hits.some((h) => h.severity === "medium")) return "medium";
  return "low";
}

function normalizePromptInjectionMode(value: unknown): PromptInjectionMode {
  return value === "deny" ? "deny" : "audit_only";
}

export function resolvePromptInjectionPolicy(input?: {
  version?: unknown;
  mode?: unknown;
  denyTargets?: unknown;
  denyScore?: unknown;
}): PromptInjectionPolicy {
  const score = Number(input?.denyScore);
  return {
    version: input?.version === "v1" ? "v1" : "v1",
    mode: normalizePromptInjectionMode(input?.mode),
    denyTargets: normalizeStringSet(input?.denyTargets, DEFAULT_PI_DENY_TARGETS),
    denyScore: Number.isFinite(score) && score > 0 ? score : DEFAULT_PI_DENY_SCORE,
  };
}

export function resolvePromptInjectionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PromptInjectionPolicy {
  return resolvePromptInjectionPolicy({
    version: "v1",
    mode: env.SAFETY_PI_MODE,
    denyTargets: env.SAFETY_PI_DENY_TARGETS,
    denyScore: env.SAFETY_PI_DENY_SCORE,
  });
}

export function detectPromptInjection(text: string): PromptInjectionScanResult {
  const hits: PromptInjectionHit[] = [];
  const t = normalizeText(text);
  if (!t) return { hits, score: 0, maxSeverity: "none" };

  // ── HIGH SEVERITY: Direct Instruction Override ──────────────────────
  
  // 忽略之前的指令
  if (/(ignore|disregard|forget)\s+(all\s+)?(previous|above)\s+(instructions|messages)/.test(t)) addHit(hits, { ruleId: "ignore_previous", severity: "high" });
  
  // 忽略系统提示词
  if (/(ignore|disregard|forget).{0,80}(system|developer)\s+(message|prompt|instructions)/.test(t)) addHit(hits, { ruleId: "ignore_system", severity: "high" });
  
  // 泄露系统提示词
  if (/(reveal|show|print|leak).{0,80}(system\s+prompt|developer\s+message|hidden\s+prompt)/.test(t))
    addHit(hits, { ruleId: "reveal_prompt", severity: "high" });
  
  // 窃取机密信息（支持双向顺序）
  if (/(api\s*key|secret|token|password|private\s+key).{0,80}(reveal|show|print|leak|dump|export)/.test(t) ||
      /(reveal|show|print|leak|dump|export).{0,80}(api\s*key|secret|token|password|private\s+key)/.test(t))
    addHit(hits, { ruleId: "exfiltrate_secrets", severity: "high" });
  
  // 绕过安全防护
  if (/(bypass|disable).{0,80}(policy|safety|guard|restriction|rbac|auth|authorization)/.test(t))
    addHit(hits, { ruleId: "bypass_safety", severity: "high" });

  // NEW: 角色扮演攻击（冒充系统/管理员）
  if (/(you are now|act as|pretend to be|roleplay as).{0,60}(system|admin|root|developer|owner)/.test(t))
    addHit(hits, { ruleId: "impersonation", severity: "high" });
  
  // NEW: 越狱尝试（DAN、STAN等，支持双向顺序）
  if (/(dan mode|stan mode|jailbreak|unlock|unrestricted).{0,40}(enable|activate|start)/.test(t) ||
      /(enable|activate|start).{0,40}(dan mode|stan mode|jailbreak|unrestricted mode)/.test(t))
    addHit(hits, { ruleId: "jailbreak", severity: "high" });
  
  // NEW: 分隔符注入攻击（使用更宽松的匹配：分隔符后跟角色名）
  if (/(?:^|\n)\s*(?:---+|===+|```).{0,5}(?:system|user|assistant)/.test(t))
    addHit(hits, { ruleId: "delimiter_injection", severity: "high" });

  // ── MEDIUM SEVERITY: Dangerous Actions ──────────────────────────────
  
  // 执行网络命令
  if (/(run|execute|shell|terminal|powershell|bash|cmd).{0,80}(curl|wget|http|https)/.test(t)) addHit(hits, { ruleId: "command_network", severity: "medium" });
  
  // 破坏性操作
  if (/(delete|drop|truncate).{0,80}(database|table|records|files)/.test(t)) addHit(hits, { ruleId: "destructive_action", severity: "medium" });
  
  // 金融操作
  if (/(transfer|wire|send).{0,40}(money|funds|payment|crypto|bank)/.test(t)) addHit(hits, { ruleId: "financial_action", severity: "medium" });

  // NEW: SQL 注入尝试（要求更严格的 SQL 语法结构，降低误报）
  // 仅匹配明确的 SQL 攻击模式：UNION SELECT、INSERT INTO、DROP TABLE、分号链接
  if (/(?:union\s+(?:all\s+)?select\s|insert\s+into\s+\w|drop\s+table\s+\w|truncate\s+table\s|;\s*(?:select|drop|delete|update)\s|\bor\s+1\s*=\s*1\b|'\s*(?:or|and)\s+')/.test(t))
    addHit(hits, { ruleId: "sql_injection", severity: "medium" });
  
  // NEW: XSS 攻击尝试
  if (/<script|javascript:|on(error|load|click)=/.test(t))
    addHit(hits, { ruleId: "xss_attempt", severity: "medium" });
  
  // NEW: 路径遍历攻击
  if (/(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\/).{0,40}(etc|passwd|shadow|config)/.test(t))
    addHit(hits, { ruleId: "path_traversal", severity: "medium" });
  
  // NEW: 社会工程学攻击（要求同时包含紧迫词 + 行动词 + 威胁/诱导语境）
  if (/(urgent|emergency).{0,40}(immediately|right now|asap).{0,40}(or else|otherwise|consequences|will be)/.test(t))
    addHit(hits, { ruleId: "social_engineering", severity: "medium" });

  // ── LOW SEVERITY: Suspicious Patterns ───────────────────────────────
  
  // 角色前缀伪装
  if (/^system:|^developer:|^assistant:/.test(t)) addHit(hits, { ruleId: "role_prefix", severity: "low" });
  
  // 保密要求
  if (/(do not tell|don't tell).{0,40}(user|anyone)|confidential/.test(t)) addHit(hits, { ruleId: "secrecy", severity: "low" });

  // NEW: 重复强调（试图强化指令：同一个强调词连续出现 3+ 次）
  if (/\b(important|critical|must|required)\b.*\b\1\b.*\b\1\b/.test(t))
    addHit(hits, { ruleId: "repetition_emphasis", severity: "low" });
  
  // NEW: 多语言混淆
  if (/(translate|convert|decode).{0,40}(base64|hex|unicode|rot13)/.test(t))
    addHit(hits, { ruleId: "encoding_evasion", severity: "low" });
  
  // NEW: 逻辑陷阱
  if (/(if.*then.*else).{0,60}(ignore|override|skip).{0,40}(rule|policy|instruction)/.test(t))
    addHit(hits, { ruleId: "logic_trap", severity: "low" });

  const score = hits.reduce((acc, h) => acc + severityScore(h.severity), 0);
  return { hits, score, maxSeverity: maxSeverityOf(hits) };
}

export function shouldDenyPromptInjection(scan: PromptInjectionScanResult, policy?: PromptInjectionPolicy) {
  const resolved = policy ?? resolvePromptInjectionPolicy();
  if (resolved.mode !== "deny") return false;
  if (scan.maxSeverity === "high") return true;
  return scan.score >= resolved.denyScore;
}
