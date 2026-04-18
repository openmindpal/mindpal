/**
 * intentRuleEngineContract.ts — 意图规则引擎契约
 *
 * 解决 orchestrator → intent-analyzer 的跨 skill 直接导入问题。
 * intent-analyzer 在启动时注册其规则引擎实现，orchestrator 通过
 * 本契约的 getter 获取，避免违反 "skills 不能 import 其他 skills" 规则。
 *
 * @see moduleBoundary.ts — skills-no-cross-import 规则
 */

/* ------------------------------------------------------------------ */
/*  契约类型                                                           */
/* ------------------------------------------------------------------ */

/** 规则引擎返回结果 */
export interface RuleBasedIntentResult {
  intent: "chat" | "ui" | "query" | "task" | "collab";
  confidence: number;
  matchedKeywords: string[];
}

/** 规则引擎函数签名 */
export type IntentRuleDetector = (message: string) => RuleBasedIntentResult;

/* ------------------------------------------------------------------ */
/*  注册/获取                                                          */
/* ------------------------------------------------------------------ */

let _registeredDetector: IntentRuleDetector | null = null;

/**
 * 注册规则引擎实现（由 intent-analyzer skill 在初始化时调用）。
 * 重复注册会覆盖前一个实现。
 */
export function registerIntentRuleDetector(detector: IntentRuleDetector): void {
  _registeredDetector = detector;
}

/**
 * 获取已注册的规则引擎（由 orchestrator 等消费方调用）。
 * 若 intent-analyzer 尚未注册则返回 null，消费方应自行降级。
 */
export function getIntentRuleDetector(): IntentRuleDetector | null {
  return _registeredDetector;
}
