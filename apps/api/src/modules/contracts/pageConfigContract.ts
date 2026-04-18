/**
 * pageConfigContract.ts — Page Config 跨层契约
 *
 * 目的：解耦 modules/governance 对 skills/ui-page-config 的直接依赖。
 * governance 通过此契约间接调用 page 相关操作，skills 在启动时注册实现。
 *
 * 依赖方向：
 *   modules/governance → modules/contracts (✓)
 *   skills/ui-page-config → modules/contracts (✓，skills 可 import modules)
 */
import type { Pool } from "pg";
import type { z } from "zod";

// ─── 共享类型（与 skills/ui-page-config/modules/pageRepo 保持一致） ───

export type PageKey = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  name: string;
};

export type PageVersionRow = {
  tenantId: string;
  scopeType: string;
  scopeId: string;
  name: string;
  version: number;
  status: string;
  pageType: string;
  title: any;
  params: any;
  dataBindings: any;
  actionBindings: any;
  ui: any;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
};

// ─── 契约接口 ───

export interface PageConfigContract {
  getDraft(pool: Pool, key: PageKey): Promise<PageVersionRow | null>;
  getLatestReleased(pool: Pool, key: PageKey): Promise<PageVersionRow | null>;
  publishFromDraft(pool: Pool, key: PageKey): Promise<PageVersionRow | null>;
  rollbackToPreviousReleased(pool: Pool, key: PageKey): Promise<PageVersionRow | null>;
  cloneReleasedVersion(pool: Pool, key: PageKey, sourceVersion: number): Promise<PageVersionRow | null>;
  setPageVersionStatus(pool: Pool, key: PageKey, version: number, status: string): Promise<void>;
  /** pageDraftSchema (Zod) — 用于 changeSet release 验证 */
  pageDraftSchema: z.ZodType<any>;
}

// ─── 注册 / 获取 ───

let _impl: PageConfigContract | null = null;

export function registerPageConfigContract(impl: PageConfigContract): void {
  if (_impl) throw new Error("[pageConfigContract] 重复注册");
  _impl = impl;
}

export function getPageConfigContract(): PageConfigContract {
  if (!_impl) throw new Error("[pageConfigContract] 未注册 — 请确保 skills/ui-page-config 已初始化");
  return _impl;
}
