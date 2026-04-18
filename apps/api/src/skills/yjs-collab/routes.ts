import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { authorize } from "../../modules/auth/authz";
import { setAuditContext } from "../../modules/audit/context";
import { requireSubject } from "../../modules/auth/guard";
import { Errors } from "../../lib/errors";
import { insertAuditEvent } from "../../modules/audit/auditRepo";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

type DocKey = string;

type DocEntry = {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<any>;
  saveTimer: NodeJS.Timeout | null;
  lastSavedAt: number;
  startedAt: number;
  participantIds: Set<string>;
  initialLen: number | null;
  updateCount: number;
  updateBytes: number;
  tenantId: string;
  spaceId: string;
  entityName: string;
  entityId: string;
};

const docs = new Map<DocKey, DocEntry>();

const messageSync = 0;
const messageAwareness = 1;
const messageMeta = 2;

const syncStep1 = 0;
const syncStep2 = 1;
const syncUpdate = 2;

function docKey(tenantId: string, spaceId: string, entityName: string, entityId: string) {
  return `${tenantId}:${spaceId}:${entityName}:${entityId}`;
}

function toB64(u8: Uint8Array) {
  return Buffer.from(u8).toString("base64");
}
function fromB64(s: string) {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function send(ws: any, encoder: encoding.Encoder) {
  ws.send(encoding.toUint8Array(encoder));
}

function ensureDoc(params: { tenantId: string; spaceId: string; entityName: string; entityId: string }) {
  const key = docKey(params.tenantId, params.spaceId, params.entityName, params.entityId);
  const existing = docs.get(key);
  if (existing) return existing;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const entry: DocEntry = {
    doc,
    awareness,
    conns: new Set(),
    saveTimer: null,
    lastSavedAt: 0,
    startedAt: Date.now(),
    participantIds: new Set(),
    initialLen: null,
    updateCount: 0,
    updateBytes: 0,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    entityName: params.entityName,
    entityId: params.entityId,
  };
  docs.set(key, entry);
  return entry;
}

async function loadInitialState(params: { pool: any; tenantId: string; spaceId: string; entityName: string; entityId: string; doc: Y.Doc }) {
  const yres = await params.pool.query(
    "SELECT state_b64 FROM yjs_documents WHERE tenant_id = $1 AND space_id = $2 AND entity_name = $3 AND entity_id = $4 LIMIT 1",
    [params.tenantId, params.spaceId, params.entityName, params.entityId],
  );
  if (yres.rowCount) {
    const u8 = fromB64(String(yres.rows[0].state_b64));
    Y.applyUpdate(params.doc, u8);
    return;
  }
  // Parse schemaName.entityName for entity_records lookup
  const dotIdx = params.entityName.indexOf(".");
  const schemaName = dotIdx > 0 ? params.entityName.slice(0, dotIdx) : "core";
  const tableName = dotIdx > 0 ? params.entityName.slice(dotIdx + 1) : params.entityName;
  const rec = await params.pool.query(
    "SELECT payload FROM entity_records WHERE tenant_id = $1 AND space_id = $2 AND schema_name = $3 AND entity_name = $4 AND id = $5 LIMIT 1",
    [params.tenantId, params.spaceId, schemaName, tableName, params.entityId],
  );
  const content = rec.rowCount ? String((rec.rows[0].payload ?? {})?.content ?? "") : "";
  const ytext = params.doc.getText("content");
  if (content) ytext.insert(0, content);
}

async function persistState(params: { pool: any; entry: DocEntry }) {
  const now = Date.now();
  if (now - params.entry.lastSavedAt < 500) return;
  params.entry.lastSavedAt = now;
  const state = Y.encodeStateAsUpdate(params.entry.doc);
  const stateB64 = toB64(state);
  await params.pool.query(
    `
      INSERT INTO yjs_documents (tenant_id, space_id, entity_name, entity_id, state_b64)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id, space_id, entity_name, entity_id)
      DO UPDATE SET state_b64 = EXCLUDED.state_b64, updated_at = now()
    `,
    [params.entry.tenantId, params.entry.spaceId, params.entry.entityName, params.entry.entityId, stateB64],
  );
  // Parse schemaName.entityName for entity_records lookup
  const dotIdx = params.entry.entityName.indexOf(".");
  const schemaName = dotIdx > 0 ? params.entry.entityName.slice(0, dotIdx) : "core";
  const tableName = dotIdx > 0 ? params.entry.entityName.slice(dotIdx + 1) : params.entry.entityName;
  const text = params.entry.doc.getText("content").toString();
  await params.pool.query(
    `
      UPDATE entity_records
      SET payload = jsonb_set(payload, '{content}', to_jsonb($5::text), true),
          revision = revision + 1,
          updated_at = now()
      WHERE tenant_id = $1 AND space_id = $2 AND schema_name = $3 AND entity_name = $4 AND id = $5
    `,
    [params.entry.tenantId, params.entry.spaceId, schemaName, tableName, params.entry.entityId, text],
  );
}

export const yjsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws/yjs/:entityName/:entityId", { websocket: true }, (socket, req) => {
    setAuditContext(req as any, { resourceType: "entity", action: "read" });
    const subject = requireSubject(req as any);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ entityName: z.string().min(1), entityId: z.string().uuid() }).parse((req as any).params);

    const readDecisionP = authorize({ pool: app.db, subjectId: subject.subjectId, tenantId: subject.tenantId, spaceId: subject.spaceId, resourceType: "entity", action: "read" });
    const writeDecisionP = authorize({ pool: app.db, subjectId: subject.subjectId, tenantId: subject.tenantId, spaceId: subject.spaceId, resourceType: "entity", action: "update" });

    const entry = ensureDoc({ tenantId: subject.tenantId, spaceId: subject.spaceId, entityName: params.entityName, entityId: params.entityId });
    entry.conns.add(socket);
    entry.participantIds.add(subject.subjectId);

    const ready = (async () => {
      if ((entry.doc as any).__loaded) return;
      await loadInitialState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, entityName: params.entityName, entityId: params.entityId, doc: entry.doc });
      (entry.doc as any).__loaded = true;
      entry.initialLen = entry.doc.getText("content").length;
      entry.doc.on("update", (update: Uint8Array, origin: any) => {
        entry.updateCount += 1;
        entry.updateBytes += update?.byteLength ?? 0;
        for (const c of entry.conns) {
          if (c === origin) continue;
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, messageSync);
          encoding.writeVarUint(enc, syncUpdate);
          encoding.writeVarUint8Array(enc, update);
          send(c, enc);
        }
        if (entry.saveTimer) return;
        entry.saveTimer = setTimeout(async () => {
          entry.saveTimer = null;
          await persistState({ pool: app.db, entry });
        }, 800);
      });
    })();

    socket.on("close", async () => {
      entry.conns.delete(socket);
      if (entry.conns.size === 0) {
        if (entry.saveTimer) {
          clearTimeout(entry.saveTimer);
          entry.saveTimer = null;
        }
        try {
          await persistState({ pool: app.db, entry });
        } catch {
        }
        try {
          const finalLen = entry.doc.getText("content").length;
          const initLen = entry.initialLen ?? 0;
          await insertAuditEvent(app.db as any, {
            subjectId: undefined,
            tenantId: entry.tenantId,
            spaceId: entry.spaceId,
            resourceType: "yjs",
            action: "entity.collab_session",
            inputDigest: { entity: entry.entityName, entityId: entry.entityId },
            outputDigest: {
              entity: entry.entityName,
              entityId: entry.entityId,
              participantCount: entry.participantIds.size,
              durationMs: Math.max(0, Date.now() - entry.startedAt),
              finalLen,
              deltaLen: finalLen - initLen,
              updateCount: entry.updateCount,
              updateBytes: entry.updateBytes,
            },
            result: "success",
            traceId: (req as any).ctx?.traceId ?? "ws",
            requestId: (req as any).ctx?.requestId ?? undefined,
          });
        } catch {
        }
        docs.delete(docKey(entry.tenantId, entry.spaceId, entry.entityName, entry.entityId));
      }
    });

    socket.on("message", async (data: any) => {
      await ready;
      const readDecision = await readDecisionP;
      if (readDecision.decision !== "allow") return;
      const writeDecision = await writeDecisionP;
      const canWrite = writeDecision.decision === "allow";

      if (typeof data === "string") return;
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const decoder = decoding.createDecoder(buf);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === messageSync) {
        const syncType = decoding.readVarUint(decoder);
        if (syncType === syncStep1) {
          const sv = decoding.readVarUint8Array(decoder);
          const update = Y.encodeStateAsUpdate(entry.doc, sv);
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, messageSync);
          encoding.writeVarUint(enc, syncStep2);
          encoding.writeVarUint8Array(enc, update);
          send(socket, enc);
          return;
        }
        if (syncType === syncStep2 || syncType === syncUpdate) {
          const update = decoding.readVarUint8Array(decoder);
          if (!canWrite) return;
          Y.applyUpdate(entry.doc, update, socket);
          return;
        }
        return;
      }
      if (messageType === messageAwareness) {
        if (!canWrite) return;
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, update, socket);
        for (const c of entry.conns) {
          if (c === socket) continue;
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, messageAwareness);
          encoding.writeVarUint8Array(enc, update);
          send(c, enc);
        }
      }
    });

    (async () => {
      await ready;
      const readDecision = await readDecisionP;
      if (readDecision.decision !== "allow") {
        socket.close();
        return;
      }
      const writeDecision = await writeDecisionP;
      const canWrite = writeDecision.decision === "allow";
      try {
        socket.send(JSON.stringify({ type: "meta", canWrite }));
      } catch {
      }
      const svEnc = encoding.createEncoder();
      encoding.writeVarUint(svEnc, messageSync);
      encoding.writeVarUint(svEnc, syncStep1);
      encoding.writeVarUint8Array(svEnc, Y.encodeStateVector(entry.doc));
      send(socket, svEnc);
      const awEnc = encoding.createEncoder();
      encoding.writeVarUint(awEnc, messageAwareness);
      const states = Array.from(entry.awareness.getStates().keys());
      encoding.writeVarUint8Array(awEnc, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, states));
      send(socket, awEnc);
    })();
  });
};
