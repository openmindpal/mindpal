/**
 * Device-OS 内核模块 #7：多通道通信（消息信封 / 重试 / ACK）
 *
 * HTTP 客户端 (apiPostJson/apiGetJson) 已统一放在上层 api.ts。
 * 本模块仅包含消息信封、重试策略、ACK/NACK 回执等传输层语义工具。
 *
 * @layer kernel
 */
import type { MessageEnvelope } from "./types";

// ── 消息信封工具 ──────────────────────────────────────────

export function createMessageEnvelope(type: string, payload: Record<string, unknown>, options?: { replyTo?: string; idempotencyKey?: string; ttlMs?: number }): MessageEnvelope {
  return { type, correlationId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), payload, replyTo: options?.replyTo, idempotencyKey: options?.idempotencyKey, ttlMs: options?.ttlMs };
}

export function isMessageExpired(msg: MessageEnvelope): boolean {
  if (!msg.ttlMs) return false;
  return Date.now() - msg.timestamp > msg.ttlMs;
}

// ── 重试策略 ──────────────────────────────────────────────

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const maxDelayMs = opts?.maxDelayMs ?? 30000;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (e: any) {
      lastError = e;
      if (attempt < maxRetries) {
        const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError ?? new Error("retry_exhausted");
}

// ── ACK/NACK 回执 ─────────────────────────────────────────

export type AckResponse = { type: "ack"; correlationId: string; timestamp: number };
export type NackResponse = { type: "nack"; correlationId: string; reason: string; timestamp: number };

export function createAck(correlationId: string): AckResponse { return { type: "ack", correlationId, timestamp: Date.now() }; }
export function createNack(correlationId: string, reason: string): NackResponse { return { type: "nack", correlationId, reason, timestamp: Date.now() }; }
