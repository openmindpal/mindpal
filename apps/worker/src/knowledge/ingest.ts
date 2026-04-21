import type { Pool } from "pg";
import { parseDocument, findParserByMimeType, StructuredLogger, sha256Hex, stableStringify } from "@openslin/shared";
import { writeKnowledgeAudit as writeAudit } from "./auditWriter";

const _logger = new StructuredLogger({ module: "worker:knowledge:ingest" });

async function loadMediaText(pool: Pool, tenantId: string, spaceId: string, mediaRef: string) {
  if (!mediaRef.startsWith("media:")) return "";
  const mediaId = mediaRef.slice("media:".length).trim();
  if (!mediaId) return "";
  const res = await pool.query(
    `
      SELECT content_type, byte_size, content_bytes
      FROM media_objects
      WHERE tenant_id = $1 AND space_id = $2 AND media_id = $3
      LIMIT 1
    `,
    [tenantId, spaceId, mediaId],
  );
  if (!res.rowCount) return "";
  const ct = String(res.rows[0].content_type ?? "");
  const bytes = res.rows[0].content_bytes as Buffer | null;
  if (!bytes) return "";

  // 先尝试统一文档解析引擎（支持 PDF/Word/Excel/PPT 等）
  const parser = findParserByMimeType(ct);
  if (parser && !ct.startsWith("text/")) {
    try {
      const result = await parseDocument({ buffer: bytes, mimeType: ct });
      if (result.text.trim()) {
        _logger.info("document parsed", { contentType: ct, method: result.stats.parseMethod, chars: result.text.length, parseTimeMs: result.stats.parseTimeMs });
        return result.text.slice(0, 500_000);
      }
    } catch (e: any) {
      _logger.warn("document parse failed, trying text fallback", { contentType: ct, err: e?.message ?? e });
    }
  }

  // 纯文本回退
  if (ct.startsWith("text/")) {
    const max = 200_000;
    const sliced = bytes.length > max ? bytes.subarray(0, max) : bytes;
    return sliced.toString("utf8");
  }

  return "";
}

export async function processKnowledgeIngestJob(params: { pool: Pool; ingestJobId: string }) {
  const jobRes = await params.pool.query("SELECT * FROM knowledge_ingest_jobs WHERE id = $1 LIMIT 1", [params.ingestJobId]);
  if (!jobRes.rowCount) return null;
  const job = jobRes.rows[0] as any;
  const tenantId = String(job.tenant_id ?? "");
  const spaceId = String(job.space_id ?? "");
  const provider = String(job.provider ?? "");
  const workspaceId = String(job.workspace_id ?? "");
  const eventId = String(job.event_id ?? "");
  const sourceEventPk = job.source_event_pk ? String(job.source_event_pk) : null;
  const traceId = `king-${params.ingestJobId}`;

  if (!tenantId || !spaceId || !provider || !workspaceId || !eventId) throw new Error("ingest_job_invalid");
  await params.pool.query("UPDATE knowledge_ingest_jobs SET status='running', attempt=attempt+1, updated_at=now() WHERE id=$1", [params.ingestJobId]);

  const startedAt = Date.now();
  try {
    const evRes = sourceEventPk
      ? await params.pool.query("SELECT id, body_json FROM channel_ingress_events WHERE id = $1 AND tenant_id = $2 LIMIT 1", [sourceEventPk, tenantId])
      : await params.pool.query(
          `
            SELECT id, body_json
            FROM channel_ingress_events
            WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND event_id = $4
            LIMIT 1
          `,
          [tenantId, provider, workspaceId, eventId],
        );
    if (!evRes.rowCount) throw new Error("source_event_not_found");
    const evPk = String(evRes.rows[0].id ?? "");
    const bodyJson = (evRes.rows[0].body_json as any) ?? null;

    let contentText = "";
    if (bodyJson && typeof bodyJson === "object") {
      const body = (bodyJson as any).body;
      const mediaRef = typeof body?.mediaRef === "string" ? body.mediaRef : "";
      if (mediaRef) contentText = await loadMediaText(params.pool, tenantId, spaceId, mediaRef);
      if (!contentText) {
        const text0 = typeof (bodyJson as any).text === "string" ? String((bodyJson as any).text) : "";
        contentText = text0 || stableStringify(bodyJson);
      }
    } else {
      contentText = String(bodyJson ?? "");
    }
    if (!contentText.trim()) contentText = `provider=${provider} workspace=${workspaceId} event=${eventId}`;

    const title = `${provider}:${eventId}`;
    const contentDigest = sha256Hex(contentText);
    const docRes = await params.pool.query(
      `
        INSERT INTO knowledge_documents (tenant_id, space_id, version, title, source_type, tags, content_text, content_digest, status, visibility, owner_subject_id)
        VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,'active','space',NULL)
        RETURNING id, version
      `,
      [tenantId, spaceId, title, `connector.${provider}`, JSON.stringify({ provider, workspaceId, eventId, sourceEventPk: evPk }), contentText, contentDigest],
    );
    const documentId = String(docRes.rows[0].id);
    const documentVersion = Number(docRes.rows[0].version ?? 1);

    const idxRes = await params.pool.query(
      `
        INSERT INTO knowledge_index_jobs (tenant_id, space_id, document_id, document_version, status)
        VALUES ($1,$2,$3,$4,'queued')
        RETURNING id
      `,
      [tenantId, spaceId, documentId, documentVersion],
    );
    const indexJobId = String(idxRes.rows[0].id);

    await params.pool.query(
      "UPDATE knowledge_ingest_jobs SET status='succeeded', last_error=NULL, source_event_pk=$2, document_id=$3, document_version=$4, updated_at=now() WHERE id=$1",
      [params.ingestJobId, evPk, documentId, documentVersion],
    );

    const latencyMs = Date.now() - startedAt;
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "ingest_job",
      inputDigest: { ingestJobId: params.ingestJobId, provider, workspaceId, eventId },
      outputDigest: { sourceEventPk: evPk, documentId, documentVersion, indexJobId, contentLen: contentText.length, latencyMs },
    });

    return { tenantId, spaceId, indexJobId };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await params.pool.query("UPDATE knowledge_ingest_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1", [params.ingestJobId, msg]);
    const code = typeof e?.code === "string" ? e.code : "";
    const permanent = msg === "source_event_not_found" || code === "23503" || msg.includes("violates foreign key constraint");
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "ingest_job",
      inputDigest: { ingestJobId: params.ingestJobId, provider, workspaceId, eventId },
      outputDigest: { error: msg },
      errorCategory: permanent ? "policy_violation" : "retryable",
    });
    if (permanent) return null;
    throw e;
  }
}
