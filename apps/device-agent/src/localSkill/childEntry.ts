/**
 * 本地 Skill 子进程入口
 * 由 sandbox.ts fork 启动，通过 IPC 接收执行指令
 *
 * 注意：本文件运行在独立子进程中，不要 import 任何 device-agent 内部模块
 * @layer localSkill
 */

// ── 未捕获异常安全处理 ──────────────────────────────────────
process.on("uncaughtException", (err) => {
  process.send?.({
    type: "result",
    ok: false,
    error: { message: err?.message ?? "uncaught_exception", code: "UNCAUGHT" },
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.send?.({
    type: "result",
    ok: false,
    error: { message: String(reason), code: "UNHANDLED_REJECTION" },
  });
  process.exit(1);
});

// ── 心跳：每 5 秒发一次，防止被父进程判定超时 ─────────────
const heartbeat = setInterval(() => {
  process.send?.({ type: "heartbeat" });
}, 5000);

// ── 30 秒无消息自动退出（安全兜底） ─────────────────────────
const idleTimeout = setTimeout(() => {
  clearInterval(heartbeat);
  process.exit(0);
}, 30_000);

// ── IPC 消息处理 ────────────────────────────────────────────
process.on("message", async (msg: any) => {
  if (!msg || msg.type !== "execute") return;

  // 收到执行指令后清除空闲超时
  clearTimeout(idleTimeout);

  const { entryPath, toolRef, input, context } = msg;

  try {
    // 1. 动态加载 skill entry
    const mod = await import(entryPath);
    const handler = mod.default?.handler ?? mod.handler ?? mod.default;

    if (typeof handler !== "function") {
      process.send?.({
        type: "result",
        ok: false,
        error: { message: "skill entry does not export a handler function", code: "NO_HANDLER" },
      });
      clearInterval(heartbeat);
      process.exit(1);
      return;
    }

    // 2. 执行 handler(input, context)
    const output = await handler(input, { toolRef, ...context });

    // 3. 返回结果
    process.send?.({ type: "result", ok: true, output });
    clearInterval(heartbeat);
    process.exit(0);
  } catch (err: any) {
    process.send?.({
      type: "result",
      ok: false,
      error: { message: err?.message ?? "skill_execution_error", code: "EXECUTION_ERROR" },
    });
    clearInterval(heartbeat);
    process.exit(1);
  }
});
