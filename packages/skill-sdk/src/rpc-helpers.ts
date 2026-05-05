/**
 * @mindpal/skill-sdk — RPC 辅助函数
 *
 * 帮助 Skill 开发者方便地创建 JSON-RPC 2.0 消息。
 * 底层复用 @mindpal/protocol 中的协议实现。
 */

import {
  type SkillRpcSuccess,
  type SkillRpcError,
  type SkillRpcNotification,
  type SkillRpcRequest,
  SKILL_RPC_JSONRPC,
  SKILL_RPC_METHODS,
  SKILL_RPC_ERRORS,
  createRpcRequest,
  createRpcSuccess as _createRpcSuccess,
  createRpcError as _createRpcError,
  createRpcNotification,
} from '@mindpal/protocol/skill-rpc';

import type { SkillProgressNotification } from './types.js';

/* ================================================================== */
/*  Re-export 协议层常量，方便开发者直接使用                                  */
/* ================================================================== */

export { SKILL_RPC_JSONRPC, SKILL_RPC_METHODS, SKILL_RPC_ERRORS, createRpcRequest };
export type { SkillRpcSuccess, SkillRpcError, SkillRpcNotification, SkillRpcRequest };

/* ================================================================== */
/*  面向 Skill 开发者的简化 API                                           */
/* ================================================================== */

/**
 * 创建 JSON-RPC 成功响应
 *
 * @example
 * ```ts
 * const response = createRpcSuccess(requestId, { answer: 42 });
 * transport.send(response);
 * ```
 */
export function createRpcSuccess<T>(id: string | number, result: T): SkillRpcSuccess<T> {
  return _createRpcSuccess(id, result);
}

/**
 * 创建 JSON-RPC 错误响应
 *
 * @example
 * ```ts
 * const error = createRpcError(requestId, -32602, 'Invalid params');
 * transport.send(error);
 * ```
 */
export function createRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): SkillRpcError {
  return _createRpcError(id, code, message, data);
}

/**
 * 创建进度通知消息
 *
 * @example
 * ```ts
 * transport.send(createProgressNotification({ percentage: 50, message: 'Processing...' }));
 * ```
 */
export function createProgressNotification(
  params: SkillProgressNotification,
): SkillRpcNotification<SkillProgressNotification> {
  return createRpcNotification(SKILL_RPC_METHODS.PROGRESS, params);
}

/**
 * 创建日志通知消息
 *
 * @example
 * ```ts
 * transport.send(createLogNotification('info', 'Skill initialized'));
 * ```
 */
export function createLogNotification(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
): SkillRpcNotification<{ level: string; message: string; data?: unknown }> {
  return createRpcNotification(SKILL_RPC_METHODS.LOG, {
    level,
    message,
    ...(data !== undefined ? { data } : {}),
  });
}
