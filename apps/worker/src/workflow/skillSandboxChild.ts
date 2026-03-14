import { pathToFileURL } from "node:url";
import type { EgressEvent, NetworkPolicy } from "./processor/runtime";
import { isAllowedEgress, normalizeNetworkPolicy } from "./processor/runtime";

function pickExecute(mod: any) {
  if (mod && typeof mod.execute === "function") return mod.execute as (req: any) => Promise<any>;
  if (mod && mod.default && typeof mod.default.execute === "function") return mod.default.execute as (req: any) => Promise<any>;
  if (mod && typeof mod.default === "function") return mod.default as (req: any) => Promise<any>;
  return null;
}

async function main() {
  process.on("message", async (m: any) => {
    if (!m || typeof m !== "object") return;
    if (m.type !== "execute") return;
    const payload = m.payload ?? {};

    const egress: EgressEvent[] = [];
    const networkPolicy: NetworkPolicy = normalizeNetworkPolicy(payload?.networkPolicy);
    const originalFetch = globalThis.fetch;

    const wrappedFetch = async (input: any, init?: any) => {
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
      const res = await originalFetch(input as any, init as any);
      egress.push({ host: chk.host, method: chk.method, allowed: true, policyMatch: chk.match, status: (res as any)?.status });
      return res;
    };

    try {
      if (typeof originalFetch !== "function") throw new Error("skill_sandbox_missing_fetch");
      globalThis.fetch = wrappedFetch as any;

      const entryPath = String(payload.entryPath ?? "");
      if (!entryPath) throw new Error("skill_sandbox_missing_entry_path");
      const mod = await import(pathToFileURL(entryPath).href);
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
      });

      (process as any).send?.({
        type: "result",
        ok: true,
        output,
        depsDigest: payload.depsDigest,
        egress,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? "skill_sandbox_error");
      (process as any).send?.({
        type: "result",
        ok: false,
        error: { message: msg },
        depsDigest: payload.depsDigest,
        egress,
      });
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });
}

void main();
