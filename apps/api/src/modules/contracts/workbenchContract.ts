/**
 * workbenchContract.ts — Workbench Manager 跨层契约
 *
 * 目的：解耦 modules/governance 对 skills/workbench-manager 的直接依赖。
 * governance 通过此契约间接调用 workbench 相关操作，skills 在启动时注册实现。
 *
 * 依赖方向：
 *   modules/governance → modules/contracts (✓)
 *   skills/workbench-manager → modules/contracts (✓，skills 可 import modules)
 */
import type { Pool, PoolClient } from "pg";

// ─── 共享类型 ───

type Q = Pool | PoolClient;

export type WorkbenchScope = {
  tenantId: string;
  scopeType: string;
  scopeId: string;
};

export type WorkbenchCanaryConfigRow = {
  tenantId: string;
  scopeType: string;
  scopeId: string;
  workbenchKey: string;
  canaryVersion: number;
  canarySubjectIds: string[];
  updatedAt: string;
};

export type WorkbenchPluginVersionRow = {
  tenantId: string;
  scopeType: string;
  scopeId: string;
  workbenchKey: string;
  version: number;
  status: string;
  artifactRef: string;
  manifestJson: any;
  manifestDigest: string;
  publishedAt: string;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};

// ─── 契约接口 ───

export interface WorkbenchContract {
  // 版本查询
  getActiveVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }): Promise<number | null>;
  getDraftVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }): Promise<WorkbenchPluginVersionRow | null>;
  getLatestReleasedVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }): Promise<WorkbenchPluginVersionRow | null>;
  getPreviousReleasedVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string; beforeVersion: number }): Promise<number | null>;

  // 发布 / 回滚
  publishFromDraft(params: WorkbenchScope & { pool: Q; workbenchKey: string; createdBySubjectId?: string | null }): Promise<WorkbenchPluginVersionRow | null>;
  rollbackActiveToPreviousReleased(params: WorkbenchScope & { pool: Q; workbenchKey: string }): Promise<number | null>;

  // Active 版本管理
  setActiveVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string; activeVersion: number }): Promise<void>;
  clearActiveVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }): Promise<void>;

  // 金丝雀配置
  getCanaryConfig(params: WorkbenchScope & { pool: Q; workbenchKey: string }): Promise<WorkbenchCanaryConfigRow | null>;
  setCanaryConfig(params: WorkbenchScope & { pool: Q; workbenchKey: string; canaryVersion: number; subjectIds: string[] }): Promise<void>;
  clearCanaryConfig(params: WorkbenchScope & { pool: Q; workbenchKey: string }): Promise<void>;
}

// ─── 注册 / 获取 ───

let _impl: WorkbenchContract | null = null;

export function registerWorkbenchContract(impl: WorkbenchContract): void {
  if (_impl) throw new Error("[workbenchContract] 重复注册");
  _impl = impl;
}

export function getWorkbenchContract(): WorkbenchContract {
  if (!_impl) throw new Error("[workbenchContract] 未注册 — 请确保 skills/workbench-manager 已初始化");
  return _impl;
}
