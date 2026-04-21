/**
 * skillSandboxChild.ts — Runner 侧 Skill 沙箱子进程
 *
 * 使用统一的沙箱基线模块，确保拦截行为与 Worker 一致。
 * Runner 侧额外提供：Worker 线程隔离、CPU 时间限制、动态代码执行封禁。
 * @see packages/shared/src/skillSandbox.ts
 */
import Module from "node:module";
import { Worker } from "node:worker_threads";
import type { EgressEvent, NetworkPolicy } from "./runtime";
import { isAllowedEgress, normalizeNetworkPolicy } from "./runtime";
import {
  resolveSandboxMode,
  buildForbiddenModulesSet,
  lockdownDynamicCodeExecution,
  restoreDynamicCodeExecution,
  pickExecute,
  createModuleLoadInterceptor,
  SANDBOX_BLOCKED_MODULES,
  SANDBOX_FORBIDDEN_MODULES_STRICT,
  SANDBOX_FORBIDDEN_MODULES_DATABASE,
  getRiskLevel,
} from "@openslin/shared";

async function main() {
  process.on("message", async (m: any) => {
    if (!m || typeof m !== "object") return;

    /* ── 心跳响应：Runner 发送 heartbeat，子进程立即回复确认 ── */
    if (m.type === "heartbeat") {
      (process as any).send?.({ type: "heartbeat_ack", ts: Date.now() });
      return;
    }

    if (m.type !== "execute") return;
    const payload = m.payload ?? {};

    // 将封禁模块列表传递给 Worker 线程（使用统一黑名单）
    const mode = resolveSandboxMode();
    const allBlocked = JSON.stringify([...SANDBOX_BLOCKED_MODULES]);
    const strictExtra = JSON.stringify([...SANDBOX_FORBIDDEN_MODULES_STRICT]);

    // 构建风险等级映射传递给 Worker
    const riskMapEntries: [string, string][] = [];
    for (const m of SANDBOX_BLOCKED_MODULES) {
      const level = getRiskLevel(m);
      if (level) riskMapEntries.push([m, level]);
    }
    const riskMapJson = JSON.stringify(riskMapEntries);

    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      const Module = require("node:module");
      // 使用 @openslin/shared 的编译产物，避免 Worker 中 require TypeScript 文件问题
      const sharedPath = ${JSON.stringify(require.resolve("@openslin/shared"))};
      const { isAllowedEgress, normalizeNetworkPolicy } = require(sharedPath);

      function pickExecute(mod) {
        if (mod && typeof mod.execute === "function") return mod.execute;
        if (mod && mod.default && typeof mod.default.execute === "function") return mod.default.execute;
        if (mod && typeof mod.default === "function") return mod.default;
        return null;
      }

      function buildApiFetch(apiBaseUrl, authToken, traceId) {
        const baseUrl = apiBaseUrl || process.env.API_BASE_URL || "http://localhost:4000";
        return async function apiFetch(path, init) {
          const url = path.startsWith("http") ? path : baseUrl + path;
          const headers = new Headers(init?.headers);
          if (authToken) headers.set("authorization", "Bearer " + authToken);
          if (traceId) headers.set("x-trace-id", traceId);
          return fetch(url, Object.assign({}, init, { headers }));
        };
      }

      function sandboxMode() {
        const raw = String(process.env.SKILL_SANDBOX_MODE ?? "").trim().toLowerCase();
        if (raw === "strict") return "strict";
        if (raw === "compat") return "compat";
        return process.env.NODE_ENV === "production" ? "strict" : "compat";
      }

      // 使用传递进来的统一封禁模块列表（SANDBOX_BLOCKED_MODULES）
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

        const wrappedFetch = async (input, init) => {
          const maxEgressRequests =
            typeof payload?.limits?.maxEgressRequests === "number" && Number.isFinite(payload.limits.maxEgressRequests)
              ? Math.max(0, Math.round(payload.limits.maxEgressRequests))
              : null;
          if (maxEgressRequests !== null && egress.length >= maxEgressRequests) {
            throw new Error("resource_exhausted:max_egress_requests");
          }
          const url = typeof input === "string" ? input : input?.url ? String(input.url) : "";
          const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
          const chk = isAllowedEgress({ policy: networkPolicy, url, method });
          if (!chk.allowed) {
            egress.push({ host: chk.host, method: chk.method, allowed: false, errorCategory: "policy_violation" });
            throw new Error(chk.reason ?? "policy_violation:egress_denied");
          }
          const res = await originalFetch(input, init);
          egress.push({ host: chk.host, method: chk.method, allowed: true, policyMatch: chk.match, status: res?.status });
          return res;
        };

        try {
          if (typeof originalFetch !== "function") throw new Error("skill_sandbox_missing_fetch");
          globalThis.fetch = wrappedFetch;

          Module._load = function (request, parent, isMain) {
            const req = String(request ?? "");
            const norm = req.startsWith("node:") ? req : req ? \`node:\${req}\` : req;
            if (denied.has(req) || denied.has(norm)) {
              const base = req.startsWith("node:") ? req.slice("node:".length) : req;
              const riskLevel = getRiskLevel(base);
              // 安全审计日志：记录被拦截的模块加载尝试
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
            context: payload.context
              ? { locale: payload.context.locale, apiFetch: buildApiFetch(payload.context.apiBaseUrl, payload.context.authToken, payload.traceId) }
              : undefined,
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

    const cpuTimeLimitMs =
      typeof payload?.cpuTimeLimitMs === "number" && Number.isFinite(payload.cpuTimeLimitMs) && payload.cpuTimeLimitMs > 0 ? Math.floor(payload.cpuTimeLimitMs) : null;

    const worker = new Worker(workerCode, { eval: true });
    const startCpu = process.cpuUsage();
    let done = false;
    let cpuTimer: any = null;
    const finish = (res: any) => {
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
