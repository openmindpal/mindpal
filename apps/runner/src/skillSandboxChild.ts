/**
 * skillSandboxChild.ts — Runner 侧 Skill 沙箱子进程
 *
 * 使用 @openslin/shared 的统一沙箱执行流程。
 * Runner 特有：Worker 线程隔离（threads）、CPU 时间限制、心跳监控。
 * @see packages/shared/src/skillExecutor.ts
 */
import { Worker } from "node:worker_threads";
import {
  SANDBOX_BLOCKED_MODULES,
  SANDBOX_FORBIDDEN_MODULES_STRICT,
  getRiskLevel,
} from "@openslin/shared";
import type { SandboxIpcPayload, SandboxIpcResultMessage } from "@openslin/shared";

async function main() {
  process.on("message", async (m: any) => {
    if (!m || typeof m !== "object") return;

    /* ── 心跳响应：Runner 发送 heartbeat，子进程立即回复确认 ── */
    if (m.type === "heartbeat") {
      (process as any).send?.({ type: "heartbeat_ack", ts: Date.now() });
      return;
    }

    if (m.type !== "execute") return;
    const payload: SandboxIpcPayload = m.payload ?? {};

    // 将封禁模块列表传递给 Worker 线程（使用统一黑名单）
    const allBlocked = JSON.stringify([...SANDBOX_BLOCKED_MODULES]);
    const strictExtra = JSON.stringify([...SANDBOX_FORBIDDEN_MODULES_STRICT]);

    // 构建风险等级映射传递给 Worker
    const riskMapEntries: [string, string][] = [];
    for (const mod of SANDBOX_BLOCKED_MODULES) {
      const level = getRiskLevel(mod);
      if (level) riskMapEntries.push([mod, level]);
    }
    const riskMapJson = JSON.stringify(riskMapEntries);

    // Worker 线程内联代码 — 使用 @openslin/shared 编译产物中的公共函数
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      const Module = require("node:module");
      const sharedPath = ${JSON.stringify(require.resolve("@openslin/shared"))};
      const shared = require(sharedPath);
      const { isAllowedEgress, normalizeNetworkPolicy, pickExecute, buildApiFetch, createEgressWrappedFetch } = shared;

      function sandboxMode() {
        const raw = String(process.env.SKILL_SANDBOX_MODE ?? "").trim().toLowerCase();
        if (raw === "strict") return "strict";
        if (raw === "compat") return "compat";
        return process.env.NODE_ENV === "production" ? "strict" : "compat";
      }

      const _riskMap = new Map(${riskMapJson});
      function getRiskLevel(moduleName) {
        const bare = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;
        return _riskMap.get(bare) || _riskMap.get("node:" + bare) || "unknown";
      }

      function forbiddenModules(mode) {
        const base = new Set(${allBlocked});
        if (mode === "strict") {
          const strict = ${strictExtra};
          for (const x of strict) base.add(x);
        }
        return base;
      }

      function lockdownDynamicCodeExecution() {
        const origEval = globalThis.eval;
        const origFunction = globalThis.Function;
        const blocker = () => { throw new Error("policy_violation:skill_dynamic_code_execution_blocked"); };
        globalThis.eval = blocker;
        globalThis.Function = new Proxy(origFunction, {
          construct() { throw new Error("policy_violation:skill_dynamic_code_execution_blocked"); },
          apply() { throw new Error("policy_violation:skill_dynamic_code_execution_blocked"); },
        });
        return { origEval, origFunction };
      }

      function restoreDynamicCodeExecution(saved) {
        globalThis.eval = saved.origEval;
        globalThis.Function = saved.origFunction;
      }

      parentPort.on("message", async (payload) => {
        const egress = [];
        const networkPolicy = normalizeNetworkPolicy(payload?.networkPolicy);
        const originalFetch = globalThis.fetch;
        const mode = sandboxMode();
        const denied = forbiddenModules(mode);
        const origLoad = Module._load;
        const origNodeExt = Module._extensions?.[".node"];
        const savedDynCode = lockdownDynamicCodeExecution();

        const maxEgressRequests =
          typeof payload?.limits?.maxEgressRequests === "number" && Number.isFinite(payload.limits.maxEgressRequests)
            ? Math.max(0, Math.round(payload.limits.maxEgressRequests))
            : null;
        const wrappedFetch = createEgressWrappedFetch({
          originalFetch,
          networkPolicy,
          egressCollector: egress,
          maxEgressRequests,
        });

        try {
          if (typeof originalFetch !== "function") throw new Error("skill_sandbox_missing_fetch");
          globalThis.fetch = wrappedFetch;

          Module._load = function (request, parent, isMain) {
            const req = String(request ?? "");
            const norm = req.startsWith("node:") ? req : req ? \`node:\${req}\` : req;
            if (denied.has(req) || denied.has(norm)) {
              const base = req.startsWith("node:") ? req.slice("node:".length) : req;
              const riskLevel = getRiskLevel(base);
              console.warn(JSON.stringify({
                module: "skillSandbox",
                action: "blocked_module_access",
                blockedModule: base,
                skillName: String(payload.toolRef ?? "unknown"),
                riskLevel,
                timestamp: new Date().toISOString(),
              }));
              throw new Error(\`policy_violation:skill_forbidden_import:\${base}\`);
            }
            return origLoad.call(this, request, parent, isMain);
          };
          if (Module._extensions) {
            Module._extensions[".node"] = function () {
              throw new Error("policy_violation:skill_native_addon_not_allowed");
            };
          }

          const entryPath = String(payload.entryPath ?? "");
          if (!entryPath) throw new Error("skill_sandbox_missing_entry_path");
          const req = Module.createRequire(entryPath);
          const mod = req(entryPath);
          const exec = pickExecute(mod);
          if (!exec) throw new Error("policy_violation:skill_missing_execute");

          const context = payload.context
            ? { locale: payload.context.locale, apiFetch: buildApiFetch({ apiBaseUrl: payload.context.apiBaseUrl, authToken: payload.context.authToken, traceId: payload.traceId }) }
            : undefined;

          const output = await exec({
            toolRef: payload.toolRef,
            tenantId: payload.tenantId,
            spaceId: payload.spaceId,
            subjectId: payload.subjectId,
            traceId: payload.traceId,
            idempotencyKey: payload.idempotencyKey,
            input: payload.input,
            limits: payload.limits,
            networkPolicy: payload.networkPolicy,
            artifactRef: payload.artifactRef,
            depsDigest: payload.depsDigest,
            context,
          });

          parentPort.postMessage({ type: "result", ok: true, output, depsDigest: payload.depsDigest, egress });
        } catch (e) {
          const msg = String(e?.message ?? "skill_sandbox_error");
          parentPort.postMessage({ type: "result", ok: false, error: { message: msg }, depsDigest: payload.depsDigest, egress });
        } finally {
          restoreDynamicCodeExecution(savedDynCode);
          globalThis.fetch = originalFetch;
          Module._load = origLoad;
          if (Module._extensions) Module._extensions[".node"] = origNodeExt;
        }
      });
    `;

    /* ── Runner 特有：CPU 时间限制 ── */
    const cpuTimeLimitMs =
      typeof payload?.cpuTimeLimitMs === "number" && Number.isFinite(payload.cpuTimeLimitMs) && payload.cpuTimeLimitMs > 0 ? Math.floor(payload.cpuTimeLimitMs) : null;

    const worker = new Worker(workerCode, { eval: true });
    const startCpu = process.cpuUsage();
    let done = false;
    let cpuTimer: any = null;
    const finish = (res: SandboxIpcResultMessage) => {
      if (done) return;
      done = true;
      if (cpuTimer) clearInterval(cpuTimer);
      try {
        worker.terminate();
      } catch {}
      (process as any).send?.(res);
    };

    if (cpuTimeLimitMs) {
      cpuTimer = setInterval(() => {
        try {
          const delta = process.cpuUsage(startCpu);
          const cpuMs = (Number(delta.user ?? 0) + Number(delta.system ?? 0)) / 1000;
          if (cpuMs > cpuTimeLimitMs) {
            finish({ type: "result", ok: false, error: { message: "resource_exhausted:cpu_time_limit" }, depsDigest: payload.depsDigest, egress: [] });
          }
        } catch {}
      }, Math.min(250, Math.max(50, Math.floor(cpuTimeLimitMs / 10))));
      cpuTimer.unref?.();
    }

    try {
      worker.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type !== "result") return;
        finish(msg);
      });
      worker.on("error", (e: any) => finish({ type: "result", ok: false, error: { message: String(e?.message ?? "skill_worker_error") }, depsDigest: payload.depsDigest, egress: [] }));
      worker.postMessage(payload);
    } catch (e: any) {
      finish({ type: "result", ok: false, error: { message: String(e?.message ?? "skill_sandbox_error") }, depsDigest: payload.depsDigest, egress: [] });
    }
  });
}

void main();
