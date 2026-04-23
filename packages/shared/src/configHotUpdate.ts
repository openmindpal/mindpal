/**
 * ConfigHotUpdate — 配置热更新引擎
 *
 * 基于 configRegistry 的验证能力 + eventBus 的分发能力。
 * 支持：apply（验证→快照→持久化→广播）、rollback、history、snapshot。
 *
 * 设计约束：
 * - 零新外部依赖，仅使用 node:crypto + 现有 configRegistry
 * - apply 流程严格按 验证→快照→写 DB→更新 env→发布事件 顺序执行
 * - rollback 复用 apply 的完整验证与发布链路
 */

import crypto from "node:crypto";
import { findConfigEntry, validateConfigValue, parseConfigValue } from "./configRegistry";

// ── 类型定义 ──────────────────────────────────────────────────

/** 单次配置变更事件 */
export interface ConfigChangeEvent {
  /** 配置环境变量名 */
  key: string;
  /** 变更前的值（null 表示首次设置） */
  oldValue: string | null;
  /** 变更后的值 */
  newValue: string;
  /** 递增版本号 */
  version: number;
  /** 值的 SHA-256 校验和（前 16 位） */
  checksum: string;
  /** 变更操作者标识 */
  changedBy: string;
  /** 租户 ID */
  tenantId?: string;
  /** 变更时间 ISO 字符串 */
  timestamp: string;
}

/** apply / rollback 操作结果 */
export interface ConfigApplyResult {
  ok: boolean;
  version?: number;
  error?: string;
}

/** 外部依赖注入（pool 必选，publish 可选） */
export interface ConfigHotUpdaterDeps {
  /** 数据库连接池（仅需 query 方法） */
  pool: { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number }> };
  /** 事件发布函数（可选，来自 eventBus.publish） */
  publish?: (event: {
    channel: string;
    type: string;
    tenantId: string;
    payload: Record<string, unknown>;
  }) => Promise<string>;
}

/** 配置热更新器公共接口 */
export interface ConfigHotUpdater {
  /** 验证→快照→持久化→广播 */
  apply(key: string, newValue: string, opts: { changedBy: string; tenantId?: string }): Promise<ConfigApplyResult>;
  /** 回滚到指定版本（复用 apply 全链路） */
  rollback(key: string, toVersion: number, opts: { changedBy: string; tenantId?: string }): Promise<ConfigApplyResult>;
  /** 查询指定配置的变更历史 */
  history(key: string, limit?: number): Promise<ConfigChangeEvent[]>;
  /** 返回当前内存配置快照 */
  snapshot(): Record<string, { value: string; version: number }>;
  /** 清理过期配置版本记录，保留每个 key 的最近 keepVersions 个版本 */
  purge(keepVersions?: number): Promise<number>;
}

// ── 工厂函数 ──────────────────────────────────────────────────

/**
 * 创建配置热更新器实例
 *
 * @param deps - 数据库连接池和可选的事件发布函数
 * @returns ConfigHotUpdater 实例
 */
export function createConfigHotUpdater(deps: ConfigHotUpdaterDeps): ConfigHotUpdater {
  const { pool, publish } = deps;

  // 内存快照：key → { value, version }
  const snapshots = new Map<string, { value: string; version: number }>();

  /** 计算值的 SHA-256 校验和（取前 16 位十六进制） */
  function computeChecksum(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  return {
    async apply(key, newValue, opts) {
      // 1. 查找配置元数据
      const entry = findConfigEntry(key);
      if (!entry) {
        return { ok: false, error: "Unknown config key" };
      }

      // 2. 检查运行时可变性
      if (!entry.runtimeMutable) {
        return { ok: false, error: "Config is not runtime mutable" };
      }

      // 3. 验证新值合法性
      const validation = validateConfigValue(entry, newValue);
      if (!validation.valid) {
        return { ok: false, error: validation.reason ?? "Validation failed" };
      }

      // 4. 计算校验和
      const checksum = computeChecksum(newValue);

      // 5. 读取当前值
      const oldValue = process.env[key] ?? entry.defaultValue ?? null;

      // 6. 写入 config_versions 表
      let version: number;
      try {
        const result = await pool.query(
          `INSERT INTO config_versions (key, old_value, new_value, version, checksum, changed_by, tenant_id, created_at)
           VALUES ($1, $2, $3, (SELECT COALESCE(MAX(version), 0) + 1 FROM config_versions WHERE key = $1), $4, $5, $6, now())
           RETURNING version`,
          [key, oldValue, newValue, checksum, opts.changedBy, opts.tenantId ?? null],
        );
        version = result.rows[0].version as number;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `DB write failed: ${msg}` };
      }

      // 7. 更新 process.env
      process.env[key] = newValue;

      // 8. 发布事件（如果提供了 publish 函数）
      if (publish) {
        try {
          await publish({
            channel: `config.updated.${key}`,
            type: "config.updated",
            tenantId: opts.tenantId ?? "system",
            payload: { key, oldValue, newValue, version, checksum, changedBy: opts.changedBy },
          });
        } catch {
          // 事件发布失败不影响 apply 结果，DB 已持久化
        }
      }

      // 9. 更新内存快照
      snapshots.set(key, { value: newValue, version });

      // 10. 返回结果
      return { ok: true, version };
    },

    async rollback(key, toVersion, opts) {
      // 1. 从 config_versions 查询目标版本的值
      let targetValue: string;
      try {
        const result = await pool.query(
          `SELECT new_value FROM config_versions WHERE key = $1 AND version = $2`,
          [key, toVersion],
        );
        if (!result.rows.length) {
          return { ok: false, error: "Version not found" };
        }
        targetValue = result.rows[0].new_value as string;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `DB read failed: ${msg}` };
      }

      // 2. 复用 apply 的完整验证与发布链路
      return this.apply(key, targetValue, opts);
    },

    async history(key, limit = 50) {
      try {
        const result = await pool.query(
          `SELECT key, old_value, new_value, version, checksum, changed_by, tenant_id, created_at
           FROM config_versions WHERE key = $1
           ORDER BY version DESC LIMIT $2`,
          [key, limit],
        );
        return result.rows.map((r: any) => ({
          key: r.key as string,
          oldValue: r.old_value as string | null,
          newValue: r.new_value as string,
          version: r.version as number,
          checksum: r.checksum as string,
          changedBy: r.changed_by as string,
          tenantId: r.tenant_id as string | undefined,
          timestamp: (r.created_at as Date | string).toString(),
        }));
      } catch {
        return [];
      }
    },

    snapshot() {
      return Object.fromEntries(snapshots);
    },

    async purge(keepVersions: number = 50): Promise<number> {
      const result = await pool.query(
        `DELETE FROM config_versions WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY key ORDER BY version DESC) AS rn
            FROM config_versions
          ) ranked WHERE rn > $1
        )`,
        [keepVersions],
      );
      return result.rows?.length ?? result.rowCount ?? 0;
    },
  };
}
