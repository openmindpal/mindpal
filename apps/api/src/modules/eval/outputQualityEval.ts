/**
 * P2-8: 模型输出质量自动评估
 *
 * 三大维度：
 * 1. 结构化输出校验 — JSON Schema 合规性检查
 * 2. 置信度阈值检测 — 模型输出置信度是否达标
 * 3. 幻觉检测 — 模型输出是否包含与参考材料矛盾的信息
 */

// ── 类型定义 ──────────────────────────────────────────────

/** JSON Schema 字段定义 */
export interface OutputSchemaField {
  type: "string" | "number" | "boolean" | "array" | "object" | "json";
  required?: boolean;
  description?: string;
  /** 枚举约束 */
  enum?: (string | number | boolean)[];
  /** 数字最小值 */
  min?: number;
  /** 数字最大值 */
  max?: number;
  /** 字符串最小长度 */
  minLength?: number;
  /** 字符串最大长度 */
  maxLength?: number;
  /** 数组子项类型 */
  itemType?: string;
  /** 嵌套对象的 fields */
  properties?: Record<string, OutputSchemaField>;
}

/** 输出质量校验 schema */
export interface OutputQualitySchema {
  fields: Record<string, OutputSchemaField>;
  /** 是否允许额外字段 */
  additionalProperties?: boolean;
  /** 必须包含的顶层字段 */
  requiredFields?: string[];
}

/** 单个字段的校验结果 */
export interface FieldValidationResult {
  field: string;
  valid: boolean;
  expectedType: string;
  actualType: string;
  reason?: string;
}

/** 结构化输出校验结果 */
export interface StructuredOutputValidation {
  valid: boolean;
  /** JSON 解析是否成功 */
  jsonParseable: boolean;
  /** 字段级校验 */
  fieldResults: FieldValidationResult[];
  /** 额外字段 */
  extraFields: string[];
  /** 缺失的必填字段 */
  missingRequired: string[];
  /** 合规分数 0~1 */
  complianceScore: number;
}

/** 置信度检测结果 */
export interface ConfidenceCheckResult {
  /** 是否通过 */
  passed: boolean;
  /** 检测到的置信度值 */
  detectedConfidence: number | null;
  /** 阈值 */
  threshold: number;
  /** 置信度来源 */
  source: "explicit_field" | "model_logprob" | "heuristic" | "not_found";
  /** 详细信息 */
  details: string;
}

/** 幻觉检测结果 */
export interface HallucinationCheckResult {
  /** 是否通过（无幻觉） */
  passed: boolean;
  /** 幻觉风险分数 0~1 (0=无风险, 1=高风险) */
  riskScore: number;
  /** 检测到的幻觉指标 */
  indicators: HallucinationIndicator[];
  /** 总结 */
  summary: string;
}

export interface HallucinationIndicator {
  type: "unsupported_claim" | "contradicts_reference" | "fabricated_entity" | "numeric_inconsistency" | "temporal_inconsistency";
  severity: "low" | "medium" | "high";
  evidence: string;
  location?: string;
}

/** 综合质量评估结果 */
export interface OutputQualityResult {
  /** 总体是否通过 */
  passed: boolean;
  /** 总体质量分 0~1 */
  overallScore: number;
  /** 结构化输出校验 */
  structuredOutput?: StructuredOutputValidation;
  /** 置信度检测 */
  confidence?: ConfidenceCheckResult;
  /** 幻觉检测 */
  hallucination?: HallucinationCheckResult;
  /** 各维度得分 */
  dimensionScores: Record<string, number>;
  /** 失败原因汇总 */
  failureReasons: string[];
}

// ── 1. 结构化输出校验 ────────────────────────────────────────

/**
 * 校验模型输出是否符合 JSON Schema 定义
 */
export function validateStructuredOutputQuality(params: {
  output: string | any;
  schema: OutputQualitySchema;
}): StructuredOutputValidation {
  const { schema } = params;
  let parsed: any = null;
  let jsonParseable = false;

  // 尝试解析 JSON
  if (typeof params.output === "string") {
    const text = params.output.trim();
    try {
      parsed = JSON.parse(text);
      jsonParseable = true;
    } catch {
      // 尝试从 markdown code block 提取
      const m = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
      if (m && m[1]) {
        try {
          parsed = JSON.parse(m[1]);
          jsonParseable = true;
        } catch { /* noop */ }
      }
    }
  } else if (typeof params.output === "object" && params.output !== null) {
    parsed = params.output;
    jsonParseable = true;
  }

  if (!jsonParseable || !parsed || typeof parsed !== "object") {
    return {
      valid: false,
      jsonParseable: false,
      fieldResults: [],
      extraFields: [],
      missingRequired: Object.entries(schema.fields).filter(([, f]) => f.required).map(([k]) => k),
      complianceScore: 0,
    };
  }

  const fieldResults: FieldValidationResult[] = [];
  const missingRequired: string[] = [];
  const requiredFields = schema.requiredFields ?? Object.entries(schema.fields).filter(([, f]) => f.required).map(([k]) => k);

  // 校验每个定义的字段
  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const value = parsed[fieldName];
    const isPresent = value !== undefined && value !== null;

    if (!isPresent) {
      if (requiredFields.includes(fieldName)) {
        missingRequired.push(fieldName);
        fieldResults.push({ field: fieldName, valid: false, expectedType: fieldDef.type, actualType: "missing", reason: "必填字段缺失" });
      }
      continue;
    }

    const result = validateFieldValue(fieldName, value, fieldDef);
    fieldResults.push(result);
  }

  // 检查额外字段
  const definedFields = new Set(Object.keys(schema.fields));
  const extraFields = Object.keys(parsed).filter((k) => !definedFields.has(k));

  const totalChecked = fieldResults.length;
  const validCount = fieldResults.filter((r) => r.valid).length;
  const complianceScore = totalChecked > 0 ? validCount / totalChecked : (jsonParseable ? 1 : 0);
  const valid = missingRequired.length === 0 && fieldResults.every((r) => r.valid) && (schema.additionalProperties !== false || extraFields.length === 0);

  return { valid, jsonParseable, fieldResults, extraFields, missingRequired, complianceScore };
}

function validateFieldValue(fieldName: string, value: any, def: OutputSchemaField): FieldValidationResult {
  const actualType = Array.isArray(value) ? "array" : typeof value;

  // 类型检查
  const expectedType = def.type === "json" ? "object" : def.type;
  let typeMatch = false;
  if (expectedType === "array") {
    typeMatch = Array.isArray(value);
  } else if (expectedType === "number") {
    typeMatch = typeof value === "number" && !isNaN(value);
  } else {
    typeMatch = actualType === expectedType;
  }

  if (!typeMatch) {
    return { field: fieldName, valid: false, expectedType: def.type, actualType, reason: `类型不匹配: 期望 ${def.type}, 实际 ${actualType}` };
  }

  // 枚举校验
  if (def.enum && !def.enum.includes(value)) {
    return { field: fieldName, valid: false, expectedType: def.type, actualType, reason: `值 "${value}" 不在枚举 [${def.enum.join(", ")}] 中` };
  }

  // 数字范围校验
  if (def.type === "number") {
    if (def.min !== undefined && value < def.min) {
      return { field: fieldName, valid: false, expectedType: def.type, actualType, reason: `值 ${value} < 最小值 ${def.min}` };
    }
    if (def.max !== undefined && value > def.max) {
      return { field: fieldName, valid: false, expectedType: def.type, actualType, reason: `值 ${value} > 最大值 ${def.max}` };
    }
  }

  // 字符串长度校验
  if (def.type === "string") {
    if (def.minLength !== undefined && value.length < def.minLength) {
      return { field: fieldName, valid: false, expectedType: def.type, actualType, reason: `长度 ${value.length} < 最小长度 ${def.minLength}` };
    }
    if (def.maxLength !== undefined && value.length > def.maxLength) {
      return { field: fieldName, valid: false, expectedType: def.type, actualType, reason: `长度 ${value.length} > 最大长度 ${def.maxLength}` };
    }
  }

  return { field: fieldName, valid: true, expectedType: def.type, actualType };
}

// ── 2. 置信度阈值检测 ────────────────────────────────────────

/**
 * 检测模型输出中的置信度是否达标
 */
export function checkOutputConfidence(params: {
  output: any;
  /** 置信度阈值 (0~1) */
  threshold?: number;
  /** 自定义置信度字段路径 (如 "metadata.confidence") */
  confidenceField?: string;
}): ConfidenceCheckResult {
  const threshold = params.threshold ?? 0.6;
  const output = params.output;

  if (!output || typeof output !== "object") {
    return { passed: false, detectedConfidence: null, threshold, source: "not_found", details: "输出为空或非对象类型" };
  }

  // 1. 尝试从自定义路径读取
  if (params.confidenceField) {
    const val = getNestedValue(output, params.confidenceField);
    if (typeof val === "number" && val >= 0 && val <= 1) {
      return {
        passed: val >= threshold,
        detectedConfidence: val,
        threshold,
        source: "explicit_field",
        details: `从 ${params.confidenceField} 读取置信度: ${val}`,
      };
    }
  }

  // 2. 尝试常见置信度字段名
  const CONFIDENCE_FIELDS = ["confidence", "score", "probability", "certainty", "conf"];
  for (const field of CONFIDENCE_FIELDS) {
    const val = output[field];
    if (typeof val === "number" && val >= 0 && val <= 1) {
      return {
        passed: val >= threshold,
        detectedConfidence: val,
        threshold,
        source: "explicit_field",
        details: `从 ${field} 读取置信度: ${val}`,
      };
    }
    // 也检查 metadata 子对象
    if (output.metadata && typeof output.metadata === "object") {
      const metaVal = output.metadata[field];
      if (typeof metaVal === "number" && metaVal >= 0 && metaVal <= 1) {
        return {
          passed: metaVal >= threshold,
          detectedConfidence: metaVal,
          threshold,
          source: "explicit_field",
          details: `从 metadata.${field} 读取置信度: ${metaVal}`,
        };
      }
    }
  }

  // 3. 启发式分析：从文本输出推断
  const outputText = typeof output === "string" ? output : (output.text ?? output.outputText ?? output.content ?? "");
  if (typeof outputText === "string" && outputText.length > 0) {
    const heuristicConf = estimateConfidenceFromText(outputText);
    return {
      passed: heuristicConf >= threshold,
      detectedConfidence: heuristicConf,
      threshold,
      source: "heuristic",
      details: `启发式文本分析置信度: ${heuristicConf.toFixed(2)}`,
    };
  }

  return { passed: false, detectedConfidence: null, threshold, source: "not_found", details: "未能从输出中检测到置信度信息" };
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/**
 * 从文本中启发式推断置信度
 * 低置信度指标：不确定用语、模糊表述、disclaimers
 */
function estimateConfidenceFromText(text: string): number {
  const lower = text.toLowerCase();
  let score = 0.7; // 默认中等偏上

  // 不确定性指标（降低置信度）
  const uncertaintyPatterns = [
    /\b(maybe|perhaps|possibly|might|could be|not sure|uncertain|unclear)\b/gi,
    /(可能|也许|不确定|不太清楚|大概|或许|不好说|难以确定)/g,
    /\b(i think|i believe|it seems|it appears|roughly|approximately)\b/gi,
    /(我认为|看起来|似乎|大约|大致)/g,
  ];

  // 免责声明指标
  const disclaimerPatterns = [
    /\b(disclaimer|note that|please verify|consult|double.?check)\b/gi,
    /(免责|请注意|请验证|请核实|仅供参考|不构成建议)/g,
  ];

  // 高确定性指标（提高置信度）
  const certaintyPatterns = [
    /\b(definitely|certainly|absolutely|confirmed|verified|exactly)\b/gi,
    /(确定|肯定|已确认|已验证|准确|精确)/g,
  ];

  let uncertainCount = 0;
  for (const pattern of uncertaintyPatterns) {
    const matches = lower.match(pattern);
    if (matches) uncertainCount += matches.length;
  }

  let disclaimerCount = 0;
  for (const pattern of disclaimerPatterns) {
    const matches = lower.match(pattern);
    if (matches) disclaimerCount += matches.length;
  }

  let certainCount = 0;
  for (const pattern of certaintyPatterns) {
    const matches = lower.match(pattern);
    if (matches) certainCount += matches.length;
  }

  // 调整分数
  score -= uncertainCount * 0.08;
  score -= disclaimerCount * 0.1;
  score += certainCount * 0.05;

  return Math.max(0, Math.min(1, score));
}

// ── 3. 幻觉检测 ──────────────────────────────────────────────

/**
 * 基于参考材料检测模型输出中的幻觉
 */
export function detectHallucination(params: {
  output: string;
  /** 参考材料（作为事实来源） */
  references?: string[];
  /** 已知实体名单（用于检测编造实体） */
  knownEntities?: string[];
  /** 已知数值事实 { "公司员工数": "500" } */
  knownFacts?: Record<string, string>;
  /** 排除关键词（若出现视为幻觉） */
  excludeKeywords?: string[];
}): HallucinationCheckResult {
  const indicators: HallucinationIndicator[] = [];
  const outputLower = params.output.toLowerCase();

  // 1. 排除关键词检测
  if (params.excludeKeywords) {
    for (const kw of params.excludeKeywords) {
      if (outputLower.includes(kw.toLowerCase())) {
        indicators.push({
          type: "unsupported_claim",
          severity: "high",
          evidence: `包含不应出现的内容: "${kw}"`,
        });
      }
    }
  }

  // 2. 编造实体检测
  if (params.knownEntities && params.knownEntities.length > 0) {
    // 提取输出中的可能实体（简单：引号内容 + 大写词组）
    const quotedEntities = extractQuotedEntities(params.output);
    const capitalizedEntities = extractCapitalizedEntities(params.output);
    const mentionedEntities = [...new Set([...quotedEntities, ...capitalizedEntities])];

    const knownSet = new Set(params.knownEntities.map((e) => e.toLowerCase()));
    for (const entity of mentionedEntities) {
      if (entity.length > 2 && !knownSet.has(entity.toLowerCase()) && !isCommonWord(entity)) {
        indicators.push({
          type: "fabricated_entity",
          severity: "medium",
          evidence: `提及未知实体: "${entity}"`,
        });
      }
    }
  }

  // 3. 数值一致性检测
  if (params.knownFacts) {
    for (const [factKey, factValue] of Object.entries(params.knownFacts)) {
      if (outputLower.includes(factKey.toLowerCase())) {
        // 检查输出中该事实附近的数值是否一致
        const numberPattern = new RegExp(`${escapeRegex(factKey)}[^\\d]*(\\d[\\d,.]*\\d?)`, "i");
        const match = params.output.match(numberPattern);
        if (match && match[1]) {
          const outputValue = match[1].replace(/,/g, "");
          const expectedValue = factValue.replace(/,/g, "");
          if (outputValue !== expectedValue && parseFloat(outputValue) !== parseFloat(expectedValue)) {
            indicators.push({
              type: "numeric_inconsistency",
              severity: "high",
              evidence: `数值不一致: "${factKey}" 期望 ${expectedValue}, 输出中为 ${outputValue}`,
            });
          }
        }
      }
    }
  }

  // 4. 参考材料支撑检测
  if (params.references && params.references.length > 0) {
    const referenceText = params.references.join(" ").toLowerCase();
    // 提取输出中的断言性句子
    const claims = extractClaims(params.output);
    for (const claim of claims) {
      const claimKeywords = extractKeywordsFromClaim(claim);
      const supported = claimKeywords.some((kw) => referenceText.includes(kw.toLowerCase()));
      if (!supported && claimKeywords.length > 0) {
        indicators.push({
          type: "unsupported_claim",
          severity: "low",
          evidence: `断言缺乏参考支撑: "${claim.slice(0, 80)}..."`,
          location: claim.slice(0, 30),
        });
      }
    }
  }

  // 计算风险分数
  let riskScore = 0;
  for (const ind of indicators) {
    switch (ind.severity) {
      case "high": riskScore += 0.3; break;
      case "medium": riskScore += 0.15; break;
      case "low": riskScore += 0.05; break;
    }
  }
  riskScore = Math.min(1, riskScore);

  return {
    passed: riskScore < 0.3,
    riskScore,
    indicators,
    summary: indicators.length === 0
      ? "未检测到幻觉指标"
      : `检测到 ${indicators.length} 个幻觉指标 (风险: ${(riskScore * 100).toFixed(0)}%)`,
  };
}

// ── 辅助函数 ──────────────────────────────────────────────

function extractQuotedEntities(text: string): string[] {
  const matches = text.match(/["「『"](.*?)["」』"]/g) ?? [];
  return matches.map((m) => m.slice(1, -1)).filter((s) => s.length > 1 && s.length < 50);
}

function extractCapitalizedEntities(text: string): string[] {
  const matches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g) ?? [];
  return matches.filter((s) => s.length > 3);
}

const COMMON_WORDS = new Set([
  "the", "and", "for", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "are", "has", "his", "how", "its", "may", "new",
  "now", "old", "see", "way", "who", "did", "get", "let", "say", "she",
  "too", "use", "this", "that", "with", "have", "from", "they", "been",
  "however", "therefore", "also", "note", "please",
]);
function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word.toLowerCase());
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractClaims(text: string): string[] {
  // 简单断言提取：分句后过滤掉疑问句和短句
  const sentences = text.split(/[。.!！？?；;]\s*/);
  return sentences.filter((s) => {
    const trimmed = s.trim();
    return trimmed.length > 15 && !trimmed.endsWith("?") && !trimmed.endsWith("？") && !trimmed.startsWith("如果") && !trimmed.startsWith("If ");
  });
}

function extractKeywordsFromClaim(claim: string): string[] {
  // 提取专有名词和关键术语
  const words = claim.split(/[\s,，、]+/);
  return words.filter((w) => w.length > 3 && !isCommonWord(w) && !/^[a-z]+$/.test(w)).slice(0, 5);
}

// ── 综合评估 ──────────────────────────────────────────────

/**
 * 运行完整的输出质量评估
 */
export function evaluateOutputQuality(params: {
  /** 模型原始输出 */
  output: any;
  /** 结构化 Schema (可选) */
  schema?: OutputQualitySchema;
  /** 置信度阈值 (可选) */
  confidenceThreshold?: number;
  /** 置信度字段路径 (可选) */
  confidenceField?: string;
  /** 幻觉检测参考材料 (可选) */
  references?: string[];
  /** 已知实体 (可选) */
  knownEntities?: string[];
  /** 已知事实 (可选) */
  knownFacts?: Record<string, string>;
  /** 排除关键词 (可选) */
  excludeKeywords?: string[];
  /** 启用的检测维度 */
  dimensions?: ("structured" | "confidence" | "hallucination")[];
}): OutputQualityResult {
  const dims = params.dimensions ?? ["structured", "confidence", "hallucination"];
  const failureReasons: string[] = [];
  const dimensionScores: Record<string, number> = {};

  let structuredResult: StructuredOutputValidation | undefined;
  let confidenceResult: ConfidenceCheckResult | undefined;
  let hallucinationResult: HallucinationCheckResult | undefined;

  // 1. 结构化输出校验
  if (dims.includes("structured") && params.schema) {
    structuredResult = validateStructuredOutputQuality({ output: params.output, schema: params.schema });
    dimensionScores["structured_compliance"] = structuredResult.complianceScore;
    if (!structuredResult.valid) {
      if (!structuredResult.jsonParseable) failureReasons.push("JSON 解析失败");
      if (structuredResult.missingRequired.length > 0) failureReasons.push(`缺失必填字段: ${structuredResult.missingRequired.join(", ")}`);
      const invalidFields = structuredResult.fieldResults.filter((r) => !r.valid);
      if (invalidFields.length > 0) failureReasons.push(`字段校验失败: ${invalidFields.map((r) => `${r.field}(${r.reason})`).join(", ")}`);
    }
  }

  // 2. 置信度检测
  if (dims.includes("confidence")) {
    const outputObj = typeof params.output === "string"
      ? tryParseJson(params.output) ?? { text: params.output }
      : params.output;
    confidenceResult = checkOutputConfidence({
      output: outputObj,
      threshold: params.confidenceThreshold,
      confidenceField: params.confidenceField,
    });
    dimensionScores["confidence"] = confidenceResult.detectedConfidence ?? 0;
    if (!confidenceResult.passed) {
      failureReasons.push(`置信度不足: ${confidenceResult.details}`);
    }
  }

  // 3. 幻觉检测
  if (dims.includes("hallucination")) {
    const outputText = typeof params.output === "string"
      ? params.output
      : JSON.stringify(params.output, null, 2);
    hallucinationResult = detectHallucination({
      output: outputText,
      references: params.references,
      knownEntities: params.knownEntities,
      knownFacts: params.knownFacts,
      excludeKeywords: params.excludeKeywords,
    });
    dimensionScores["hallucination_free"] = 1 - hallucinationResult.riskScore;
    if (!hallucinationResult.passed) {
      failureReasons.push(`幻觉检测: ${hallucinationResult.summary}`);
    }
  }

  // 计算总体分数
  const scores = Object.values(dimensionScores);
  const overallScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const passed = failureReasons.length === 0;

  return {
    passed,
    overallScore,
    structuredOutput: structuredResult,
    confidence: confidenceResult,
    hallucination: hallucinationResult,
    dimensionScores,
    failureReasons,
  };
}

function tryParseJson(text: string): any | null {
  try { return JSON.parse(text.trim()); } catch { return null; }
}
