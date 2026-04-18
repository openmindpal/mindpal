/**
 * Re-export from lib/promptInjection.ts — 消除重复实现，
 * 保留此文件仅为保持 skill 内部 import 路径不变。
 */
export {
  type PromptInjectionSummary,
  getPromptInjectionModeFromEnv,
  getPromptInjectionDenyTargetsFromEnv,
  getPromptInjectionPolicyFromEnv,
  scanPromptInjection,
  summarizePromptInjection,
  shouldDenyPromptInjectionForTarget,
  extractTextForPromptInjectionScan,
} from "../../../lib/promptInjection";
