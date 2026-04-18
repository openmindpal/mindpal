/**
 * validateEnv.ts — 基于 configRegistry 的启动时环境变量校验
 *
 * 利用 configRegistry.data.json 的元数据自动构建校验逻辑：
 * - 按 scope 筛选当前端所需环境变量
 * - 检查无默认值的必填项
 * - 检查类型匹配（number / boolean / string[]）
 * - 检查 validValues 枚举约束
 * - 输出结构化校验报告
 */
import {
  CONFIG_REGISTRY,
  type ConfigEntry,
  type ConfigScope,
} from "./configRegistry";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface EnvValidationIssue {
  envKey: string;
  severity: "error" | "warning";
  message: string;
}

export interface EnvValidationResult {
  valid: boolean;
  /** 致命问题（缺少必填项 / 类型错误 / 枚举越界）→ 建议阻断启动 */
  errors: EnvValidationIssue[];
  /** 非致命提示（可选项缺失 / 建议设置）→ 允许启动 */
  warnings: EnvValidationIssue[];
  /** 校验涉及的条目总数 */
  checkedCount: number;
}

/* ================================================================== */
/*  Core                                                                */
/* ================================================================== */

/**
 * 校验当前环境变量是否满足指定 scope 的配置要求。
 *
 * @param scope 当前应用身份（api / worker / runner / shared）
 * @param env   环境变量源，默认 process.env
 * @param opts  额外选项
 *   - strict: 生产环境模式，required 项缺失为 error；默认 NODE_ENV=production 时启用
 *   - extraRequired: 额外的必填 envKey 列表（不在 registry 中的项）
 */
export function validateEnvironment(
  scope: ConfigScope,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  opts?: {
    strict?: boolean;
    extraRequired?: string[];
  },
): EnvValidationResult {
  const strict = opts?.strict ?? (env.NODE_ENV === "production");
  const errors: EnvValidationIssue[] = [];
  const warnings: EnvValidationIssue[] = [];

  // 1. 筛选当前 scope 的条目
  const entries = CONFIG_REGISTRY.filter((e) => e.scopes.includes(scope));

  for (const entry of entries) {
    const raw = env[entry.envKey];
    const hasValue = raw !== undefined && raw.trim() !== "";

    // 2. 必填检查
    if (!hasValue && entry.defaultValue === undefined) {
      if (strict) {
        // 敏感项（密钥等）在生产环境必须提供
        if (entry.sensitive) {
          errors.push({ envKey: entry.envKey, severity: "error", message: `缺少必填敏感配置「${entry.description}」` });
        } else {
          errors.push({ envKey: entry.envKey, severity: "error", message: `缺少必填配置「${entry.description}」` });
        }
      } else {
        warnings.push({ envKey: entry.envKey, severity: "warning", message: `未设置「${entry.description}」，将使用运行时默认行为` });
      }
      continue;
    }

    if (!hasValue) continue; // 有默认值且未提供 → 跳过

    const value = raw!.trim();

    // 3. 类型检查
    if (entry.valueType === "number") {
      if (!isFiniteNumber(value)) {
        errors.push({ envKey: entry.envKey, severity: "error", message: `「${entry.description}」值 "${value}" 不是有效数字` });
      }
    }
    if (entry.valueType === "boolean") {
      const valid = ["0", "1", "true", "false", "yes", "no"].includes(value.toLowerCase());
      if (!valid) {
        errors.push({ envKey: entry.envKey, severity: "error", message: `「${entry.description}」值 "${value}" 不是有效布尔值（应为 0/1/true/false/yes/no）` });
      }
    }

    // 4. 枚举约束检查
    if (entry.validValues && entry.validValues.length > 0) {
      if (!entry.validValues.includes(value)) {
        errors.push({
          envKey: entry.envKey,
          severity: "error",
          message: `「${entry.description}」值 "${value}" 不在合法范围内 [${entry.validValues.join(", ")}]`,
        });
      }
    }
  }

  // 5. 额外必填检查
  if (opts?.extraRequired) {
    for (const key of opts.extraRequired) {
      const raw = env[key];
      if (!raw || !raw.trim()) {
        errors.push({ envKey: key, severity: "error", message: `缺少必填配置 ${key}` });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checkedCount: entries.length + (opts?.extraRequired?.length ?? 0),
  };
}

/* ================================================================== */
/*  Pretty Printer                                                      */
/* ================================================================== */

/**
 * 将校验结果格式化为可读的日志文本。
 * 适合在 console.error / logger.info 中输出。
 */
export function formatValidationResult(result: EnvValidationResult): string {
  const lines: string[] = [];

  if (result.valid && result.warnings.length === 0) {
    lines.push(`[EnvValidation] ✅ ${result.checkedCount} 项配置校验通过`);
    return lines.join("\n");
  }

  if (result.errors.length > 0) {
    lines.push(`[EnvValidation] ❌ ${result.errors.length} 项配置校验失败:`);
    for (const e of result.errors) {
      lines.push(`  ERROR  ${e.envKey}: ${e.message}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push(`[EnvValidation] ⚠️  ${result.warnings.length} 项配置建议:`);
    for (const w of result.warnings) {
      lines.push(`  WARN   ${w.envKey}: ${w.message}`);
    }
  }

  return lines.join("\n");
}

/* ================================================================== */
/*  Helpers                                                             */
/* ================================================================== */

function isFiniteNumber(s: string): boolean {
  const n = Number(s);
  return Number.isFinite(n);
}
