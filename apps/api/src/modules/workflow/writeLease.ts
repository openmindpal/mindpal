/**
 * writeLease.ts — 重导出自 @openslin/shared，消除 API/Worker 完全相同的克隆
 */
export { acquireWriteLease, renewWriteLease, releaseWriteLease } from "@openslin/shared";
export type { WriteLeaseOwner } from "@openslin/shared";
