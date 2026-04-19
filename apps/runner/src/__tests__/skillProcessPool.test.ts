/**
 * skillProcessPool.test.ts — SkillProcessPool 进程池生命周期管理单元测试
 *
 * 功能目标：验证进程池的 acquire/release/discard/shutdown 生命周期，
 * 以及 maxUses 回收、空闲超时清理、内存限制传递等核心机制。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/* ── mock child_process.fork ─────────────────────────────────── */
function createMockChildProcess(overrides?: Partial<{ connected: boolean; killed: boolean }>) {
  const cp = new EventEmitter() as EventEmitter & {
    connected: boolean;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  cp.connected = overrides?.connected ?? true;
  cp.killed = overrides?.killed ?? false;
  cp.kill = vi.fn(() => {
    cp.killed = true;
    cp.connected = false;
  });
  cp.pid = Math.floor(Math.random() * 90000) + 10000;
  return cp;
}

vi.mock("node:child_process", () => ({
  default: {
    fork: vi.fn(() => createMockChildProcess()),
  },
  fork: vi.fn(() => createMockChildProcess()),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  },
}));

import { SkillProcessPool } from "../skillProcessPool";
import child_process from "node:child_process";

describe("SkillProcessPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* ── acquire ─────────────────────────────────────────────── */
  describe("acquire", () => {
    it("池空时应 fork 新子进程", async () => {
      const pool = new SkillProcessPool({ poolSize: 2, maxIdleMs: 60000, maxUses: 10 });
      const { child, _poolEntry } = await pool.acquire();

      expect(child_process.fork).toHaveBeenCalledTimes(1);
      expect(child).toBeDefined();
      expect(child.connected).toBe(true);
      // 新 fork 的进程没有池条目
      expect(_poolEntry).toBeNull();
    });

    it("空闲池有进程时应复用而非 fork 新进程", async () => {
      const pool = new SkillProcessPool({ poolSize: 2, maxIdleMs: 60000, maxUses: 10 });

      // 先 acquire 再 release 使进程进入空闲池
      const first = await pool.acquire();
      pool.release(first.child, first._poolEntry);
      vi.clearAllMocks();

      // 再次 acquire 应复用
      const second = await pool.acquire();
      expect(child_process.fork).not.toHaveBeenCalled();
      expect(second.child).toBe(first.child);
    });

    it("传递 memoryMb 配置到 fork execArgv", async () => {
      const pool = new SkillProcessPool({ poolSize: 1, maxIdleMs: 60000, maxUses: 10 });
      await pool.acquire({ memoryMb: 512 });

      expect(child_process.fork).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          execArgv: expect.arrayContaining(["--max-old-space-size=512"]),
        }),
      );
    });

    it("shutdown 后 acquire 应抛出异常", async () => {
      const pool = new SkillProcessPool({ poolSize: 1 });
      await pool.shutdown();

      await expect(pool.acquire()).rejects.toThrow("skill_process_pool_shutdown");
    });
  });

  /* ── release ─────────────────────────────────────────────── */
  describe("release", () => {
    it("正常回收到空闲池（新 fork 进程无 poolEntry）", async () => {
      const pool = new SkillProcessPool({ poolSize: 2, maxIdleMs: 60000, maxUses: 10 });
      const { child, _poolEntry } = await pool.acquire();

      pool.release(child, _poolEntry);
      vi.clearAllMocks();

      // 再次 acquire 应复用
      const second = await pool.acquire();
      expect(child_process.fork).not.toHaveBeenCalled();
      expect(second.child).toBe(child);
    });

    it("超过 maxUses 时应 kill 进程并补充新进程", async () => {
      const pool = new SkillProcessPool({ poolSize: 1, maxIdleMs: 60000, maxUses: 2 });

      // 第一轮：acquire → release（uses=1）
      const first = await pool.acquire();
      pool.release(first.child, first._poolEntry);

      // 取出 poolEntry
      const second = await pool.acquire();
      expect(second._poolEntry).not.toBeNull();

      // release 时 uses 变为 2 >= maxUses(2)，应 kill
      pool.release(second.child, second._poolEntry);
      expect(second.child.kill).toHaveBeenCalled();
    });

    it("shutdown 期间 release 应直接 kill", async () => {
      const pool = new SkillProcessPool({ poolSize: 2, maxIdleMs: 60000, maxUses: 10 });
      const { child, _poolEntry } = await pool.acquire();

      await pool.shutdown();
      pool.release(child, _poolEntry);
      expect(child.kill).toHaveBeenCalled();
    });
  });

  /* ── discard ─────────────────────────────────────────────── */
  describe("discard", () => {
    it("出错时直接 kill 不归还池", async () => {
      const pool = new SkillProcessPool({ poolSize: 2, maxIdleMs: 60000, maxUses: 10 });
      const { child } = await pool.acquire();

      pool.discard(child);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      // 再次 acquire 应 fork 新进程
      vi.clearAllMocks();
      await pool.acquire();
      expect(child_process.fork).toHaveBeenCalledTimes(1);
    });
  });

  /* ── shutdown ────────────────────────────────────────────── */
  describe("shutdown", () => {
    it("优雅关闭所有空闲进程", async () => {
      const pool = new SkillProcessPool({ poolSize: 3, maxIdleMs: 60000, maxUses: 50 });

      // warmup 填充池
      await pool.warmup();
      const forkCount = (child_process.fork as ReturnType<typeof vi.fn>).mock.results.length;
      expect(forkCount).toBeGreaterThanOrEqual(3);

      // 收集所有 mock child
      const children = (child_process.fork as ReturnType<typeof vi.fn>).mock.results.map(
        (r: { value: ReturnType<typeof createMockChildProcess> }) => r.value,
      );

      await pool.shutdown();

      // 所有子进程都应被 kill
      for (const c of children) {
        expect(c.kill).toHaveBeenCalled();
      }
    });
  });

  /* ── 空闲超时 ────────────────────────────────────────────── */
  describe("idle timeout", () => {
    it("超过 maxIdleMs 的进程应被自动清理", async () => {
      const maxIdleMs = 1000;
      const pool = new SkillProcessPool({ poolSize: 2, maxIdleMs, maxUses: 50 });

      const { child, _poolEntry } = await pool.acquire();
      pool.release(child, _poolEntry);

      // 推进时间超过 maxIdleMs
      vi.advanceTimersByTime(maxIdleMs + 100);

      // 进程应被 kill
      expect(child.kill).toHaveBeenCalled();
    });
  });
});
