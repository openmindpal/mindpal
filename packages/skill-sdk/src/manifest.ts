/**
 * @mindpal/skill-sdk — Skill 清单（Manifest）标准 + 校验
 *
 * Re-export 协议包中的 Manifest 类型和校验函数，
 * 并提供面向开发者的 defineSkill 便捷构建器。
 */

import type { ExternalSkillManifest } from '@mindpal/protocol/skill-manifest';
import { validateManifest } from '@mindpal/protocol/skill-manifest';

/* ================================================================== */
/*  Re-export 协议层类型                                                 */
/* ================================================================== */

export { validateManifest };
export type { ExternalSkillManifest };
export type { SkillToolDeclaration, SkillLayer, ManifestValidationResult } from '@mindpal/protocol/skill-manifest';

/* ================================================================== */
/*  开发者友好 API                                                       */
/* ================================================================== */

/**
 * 定义 Skill 清单的便捷函数
 *
 * 提供类型安全的清单定义，并在开发阶段进行校验。
 * 如果清单校验失败，会在开发模式下打印警告。
 *
 * @example
 * ```ts
 * import { defineSkill } from '@mindpal/skill-sdk/manifest';
 *
 * export default defineSkill({
 *   identity: { name: 'community.echo', version: '1.0.0' },
 *   entry: 'dist/index.js',
 *   category: 'utility',
 *   tags: ['echo', 'demo'],
 *   io: {
 *     inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
 *     outputSchema: { type: 'object', properties: { echo: { type: 'string' } } },
 *   },
 * });
 * ```
 */
export function defineSkill(manifest: ExternalSkillManifest): ExternalSkillManifest {
  // 开发阶段校验
  const result = validateManifest(manifest);
  if (!result.valid) {
    const errMsg = `[skill-sdk] Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`;
    // 在非生产环境下打印警告
    if (typeof process !== 'undefined' && process.env?.['NODE_ENV'] !== 'production') {
      console.warn(errMsg);
    }
  }
  return manifest;
}
