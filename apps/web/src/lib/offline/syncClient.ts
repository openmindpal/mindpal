import { apiFetch } from "@/lib/api";
import { decryptJson, encryptJson, exportKeyJwk, generateAesGcmKey, importKeyJwk } from "./crypto";
import { idbGet, idbGetAll, idbPut, openOfflineDb } from "./idb";

type StoredKey = { keyId: string; jwk: JsonWebKey; createdAt: string };
type StoredOp = {
  opId: string;
  createdAt: string;
  status: "pending" | "accepted" | "rejected" | "conflict";
  meta: { schemaName: string; entityName: string; recordId: string; baseVersion: number | null };
  ivB64: string;
  ctB64: string;
  cursor: number | null;
  conflict: any | null;
};

type StoredMeta = { id: string; value: any };

export type SyncOp = {
  opId: string;
  schemaName: string;
  schemaVersion?: number;
  entityName: string;
  recordId: string;
  baseVersion?: number | null;
  patch: Record<string, unknown>;
  clock?: unknown;
};

export async function getOrCreateKey(keyId: string) {
  const db = await openOfflineDb();
  const existing = await idbGet<StoredKey>(db, "keys", keyId);
  if (existing?.jwk) return importKeyJwk(existing.jwk);
  const key = await generateAesGcmKey();
  const jwk = (await exportKeyJwk(key)) as JsonWebKey;
  await idbPut(db, "keys", { keyId, jwk, createdAt: new Date().toISOString() } satisfies StoredKey);
  return key;
}

export async function enqueueOp(params: { locale: string; keyId: string; op: SyncOp }) {
  const db = await openOfflineDb();
  const key = await getOrCreateKey(params.keyId);
  const { ivB64, ctB64 } = await encryptJson({ key, value: params.op });
  const meta = {
    schemaName: params.op.schemaName,
    entityName: params.op.entityName,
    recordId: params.op.recordId,
    baseVersion: params.op.baseVersion ?? null,
  };
  const row: StoredOp = {
    opId: params.op.opId,
    createdAt: new Date().toISOString(),
    status: "pending",
    meta,
    ivB64,
    ctB64,
    cursor: null,
    conflict: null,
  };
  await idbPut(db, "ops", row);
  return row;
}

export async function listStoredOps() {
  const db = await openOfflineDb();
  return idbGetAll<StoredOp>(db, "ops");
}

export async function decryptOp(params: { keyId: string; row: StoredOp }) {
  const key = await getOrCreateKey(params.keyId);
  return decryptJson<SyncOp>({ key, ivB64: params.row.ivB64, ctB64: params.row.ctB64 });
}

export async function updateStoredOp(params: { opId: string; patch: Partial<StoredOp> }) {
  const db = await openOfflineDb();
  const existing = await idbGet<StoredOp>(db, "ops", params.opId);
  if (!existing) return null;
  const next: StoredOp = { ...existing, ...params.patch, opId: existing.opId };
  await idbPut(db, "ops", next);
  return next;
}

export async function getMeta<T>(id: string): Promise<T | null> {
  const db = await openOfflineDb();
  const row = await idbGet<StoredMeta>(db, "meta", id);
  return row ? (row.value as T) : null;
}

export async function setMeta(id: string, value: any) {
  const db = await openOfflineDb();
  await idbPut(db, "meta", { id, value } satisfies StoredMeta);
}

export async function syncPush(params: { locale: string; keyId: string; clientId: string; deviceId?: string; onlyOpIds?: string[] }) {
  const db = await openOfflineDb();
  const rows = await idbGetAll<StoredOp>(db, "ops");
  const pending = rows.filter((r) => r.status === "pending" && (!params.onlyOpIds || params.onlyOpIds.includes(r.opId)));
  const ops: SyncOp[] = [];
  for (const r of pending) ops.push(await decryptOp({ keyId: params.keyId, row: r }));

  const res = await apiFetch(`/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    locale: params.locale,
    body: JSON.stringify({ clientId: params.clientId, deviceId: params.deviceId, ops }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) return { ok: false as const, status: res.status, body: json };

  const accepted = Array.isArray(json?.accepted) ? (json.accepted as any[]) : [];
  const conflicts = Array.isArray(json?.conflicts) ? (json.conflicts as any[]) : [];
  const acceptedById = new Map<string, any>();
  for (const a of accepted) acceptedById.set(String(a.opId ?? ""), a);
  const conflictsById = new Map<string, any>();
  for (const c of conflicts) conflictsById.set(String(c.opId ?? ""), c);

  for (const r of rows) {
    if (!pending.some((p) => p.opId === r.opId)) continue;
    const a = acceptedById.get(r.opId);
    const c = conflictsById.get(r.opId);
    if (a) {
      await idbPut(db, "ops", { ...r, status: "accepted", cursor: Number(a.cursor ?? 0), conflict: null } satisfies StoredOp);
    } else if (c) {
      await idbPut(db, "ops", { ...r, status: "conflict", conflict: c } satisfies StoredOp);
    } else {
      await idbPut(db, "ops", { ...r, status: "rejected" } satisfies StoredOp);
    }
  }
  return { ok: true as const, status: res.status, body: json };
}

export async function syncPull(params: { locale: string; clientId: string; cursor?: number; limit?: number }) {
  const res = await apiFetch(`/sync/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    locale: params.locale,
    body: JSON.stringify({ cursor: params.cursor, limit: params.limit }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) return { ok: false as const, status: res.status, body: json };
  return { ok: true as const, status: res.status, body: json };
}

export type ReplayStatus = "idle" | "replaying" | "paused" | "error";

export type ReplayProgressCallback = (progress: {
  total: number;
  completed: number;
  accepted: number;
  rejected: number;
  conflicts: number;
  currentOpId: string | null;
  status: ReplayStatus;
  error?: string;
}) => void;

export class OfflineQueueManager {
  private status: ReplayStatus = "idle";
  private abortController: AbortController | null = null;
  private retryCount = 0;
  private readonly maxRetries: number;
  private readonly batchSize: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(config?: {
    maxRetries?: number;
    batchSize?: number;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
  }) {
    this.maxRetries = config?.maxRetries ?? 5;
    this.batchSize = config?.batchSize ?? 20;
    this.retryDelayMs = config?.retryDelayMs ?? 1000;
    this.maxRetryDelayMs = config?.maxRetryDelayMs ?? 30000;
  }

  getStatus(): ReplayStatus { return this.status; }

  async getQueueStats(): Promise<{
    pending: number;
    accepted: number;
    rejected: number;
    conflict: number;
    total: number;
    oldestPendingAt: string | null;
  }> {
    const allOps = await listStoredOps();
    const pending = allOps.filter((o) => o.status === "pending");
    return {
      pending: pending.length,
      accepted: allOps.filter((o) => o.status === "accepted").length,
      rejected: allOps.filter((o) => o.status === "rejected").length,
      conflict: allOps.filter((o) => o.status === "conflict").length,
      total: allOps.length,
      oldestPendingAt: pending.length > 0
        ? pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].createdAt
        : null,
    };
  }

  async startReplay(params: {
    locale: string;
    keyId: string;
    clientId: string;
    deviceId?: string;
    onProgress?: ReplayProgressCallback;
  }): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    conflicts: number;
    retriesUsed: number;
  }> {
    if (this.status === "replaying") {
      throw new Error("replay_already_running");
    }

    this.status = "replaying";
    this.retryCount = 0;
    this.abortController = new AbortController();

    let totalProcessed = 0;
    let totalAccepted = 0;
    let totalRejected = 0;
    let totalConflicts = 0;

    try {
      while (true) {
        if (this.abortController.signal.aborted) {
          this.status = "paused";
          break;
        }

        const allOps = await listStoredOps();
        const pending = allOps
          .filter((o) => o.status === "pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, this.batchSize);

        if (pending.length === 0) {
          this.status = "idle";
          break;
        }

        const batchOpIds = pending.map((p) => p.opId);
        params.onProgress?.({
          total: allOps.filter((o) => o.status === "pending").length,
          completed: totalProcessed,
          accepted: totalAccepted,
          rejected: totalRejected,
          conflicts: totalConflicts,
          currentOpId: batchOpIds[0],
          status: "replaying",
        });

        const result = await syncPush({
          locale: params.locale,
          keyId: params.keyId,
          clientId: params.clientId,
          deviceId: params.deviceId,
          onlyOpIds: batchOpIds,
        });

        if (!result.ok) {
          this.retryCount++;
          if (this.retryCount > this.maxRetries) {
            this.status = "error";
            params.onProgress?.({
              total: pending.length, completed: totalProcessed,
              accepted: totalAccepted, rejected: totalRejected, conflicts: totalConflicts,
              currentOpId: null, status: "error",
              error: `Max retries reached (${this.maxRetries})`,
            });
            break;
          }
          const delay = Math.min(this.retryDelayMs * Math.pow(2, this.retryCount - 1), this.maxRetryDelayMs);
          await sleep(delay);
          continue;
        }

        this.retryCount = 0;

        const body = result.body ?? {};
        const accepted = Array.isArray(body.accepted) ? body.accepted.length : 0;
        const rejected = Array.isArray(body.rejected) ? body.rejected.length : 0;
        const conflicts = Array.isArray(body.conflicts) ? body.conflicts.length : 0;

        totalProcessed += batchOpIds.length;
        totalAccepted += accepted;
        totalRejected += rejected;
        totalConflicts += conflicts;

        params.onProgress?.({
          total: allOps.filter((o) => o.status === "pending").length - batchOpIds.length,
          completed: totalProcessed,
          accepted: totalAccepted,
          rejected: totalRejected,
          conflicts: totalConflicts,
          currentOpId: null,
          status: "replaying",
        });
      }
    } catch (err: any) {
      this.status = "error";
      params.onProgress?.({
        total: 0, completed: totalProcessed,
        accepted: totalAccepted, rejected: totalRejected, conflicts: totalConflicts,
        currentOpId: null, status: "error",
        error: err?.message ?? String(err),
      });
    }

    return {
      total: totalProcessed,
      accepted: totalAccepted,
      rejected: totalRejected,
      conflicts: totalConflicts,
      retriesUsed: this.retryCount,
    };
  }

  pause() {
    if (this.status === "replaying") {
      this.abortController?.abort();
      this.status = "paused";
    }
  }

  async purgeCompleted(keepRecent: number = 100) {
    const db = await openOfflineDb();
    const allOps = await idbGetAll<StoredOp>(db, "ops");
    const completed = allOps
      .filter((o) => o.status === "accepted")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const toPurge = completed.slice(keepRecent);
    for (const op of toPurge) {
      const tx = db.transaction("ops", "readwrite");
      tx.objectStore("ops").delete(op.opId);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    return { purged: toPurge.length, remaining: allOps.length - toPurge.length };
  }

  async getConflictOps(): Promise<StoredOp[]> {
    const allOps = await listStoredOps();
    return allOps.filter((o) => o.status === "conflict");
  }

  async retryConflictOp(params: {
    opId: string;
    resolvedPatch?: Record<string, unknown>;
    keyId: string;
  }) {
    const db = await openOfflineDb();
    const existing = await idbGet<StoredOp>(db, "ops", params.opId);
    if (!existing || existing.status !== "conflict") return null;

    if (params.resolvedPatch) {
      const key = await getOrCreateKey(params.keyId);
      const decrypted = await decryptOp({ keyId: params.keyId, row: existing });
      const updatedOp: SyncOp = { ...decrypted, patch: params.resolvedPatch, opId: `${params.opId}_r${Date.now()}` };
      const { ivB64, ctB64 } = await encryptJson({ key, value: updatedOp });
      const newRow: StoredOp = {
        ...existing,
        opId: updatedOp.opId,
        status: "pending",
        ivB64,
        ctB64,
        conflict: null,
      };
      await idbPut(db, "ops", newRow);
      await idbPut(db, "ops", { ...existing, status: "rejected" } satisfies StoredOp);
      return newRow;
    }

    const updated: StoredOp = { ...existing, status: "pending", conflict: null };
    await idbPut(db, "ops", updated);
    return updated;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

export function createAutoReplayListener(params: {
  manager: OfflineQueueManager;
  locale: string;
  keyId: string;
  clientId: string;
  deviceId?: string;
  onProgress?: ReplayProgressCallback;
}): { start: () => void; stop: () => void } {
  let handler: (() => void) | null = null;

  function start() {
    handler = async () => {
      if (!isOnline()) return;
      const stats = await params.manager.getQueueStats();
      if (stats.pending === 0) return;
      await params.manager.startReplay({
        locale: params.locale,
        keyId: params.keyId,
        clientId: params.clientId,
        deviceId: params.deviceId,
        onProgress: params.onProgress,
      }).catch(() => { /* fire-and-forget */ });
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", handler);
    }
  }

  function stop() {
    if (handler && typeof window !== "undefined") {
      window.removeEventListener("online", handler);
    }
    params.manager.pause();
  }

  return { start, stop };
}
