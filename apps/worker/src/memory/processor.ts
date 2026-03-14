import crypto from "node:crypto";
import type { Pool } from "pg";
import { redactValue } from "@openslin/shared";

function sha256(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export async function memoryWrite(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  input: any;
}) {
  const scope = params.input?.scope === "space" ? "space" : "user";
  const type = String(params.input?.type ?? "other");
  const title = params.input?.title ? String(params.input.title) : null;
  const contentTextRaw = String(params.input?.contentText ?? "");
  const writePolicy = String(params.input?.writePolicy ?? "confirmed");
  const retentionDays = typeof params.input?.retentionDays === "number" && Number.isFinite(params.input.retentionDays) ? params.input.retentionDays : null;
  const expiresAt = retentionDays ? new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const redacted = redactValue(contentTextRaw);
  const contentText = String(redacted.value ?? "");
  const digest = sha256(contentText);

  const ownerSubjectId = scope === "user" ? params.subjectId : null;
  const res = await params.pool.query(
    `
      INSERT INTO memory_entries (
        tenant_id, space_id, owner_subject_id, scope, type, title,
        content_text, content_digest, retention_days, expires_at, write_policy, source_ref
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, scope, type, title, created_at
    `,
    [
      params.tenantId,
      params.spaceId,
      ownerSubjectId,
      scope,
      type,
      title,
      contentText,
      digest,
      retentionDays,
      expiresAt,
      writePolicy,
      JSON.stringify({ kind: "tool", tool: "memory.write" }),
    ],
  );
  const row = res.rows[0] as any;
  return { entry: { id: row.id, scope: row.scope, type: row.type, title: row.title, createdAt: row.created_at }, dlpSummary: redacted.summary };
}

export async function memoryRead(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; input: any }) {
  const scope = params.input?.scope === "space" ? "space" : params.input?.scope === "user" ? "user" : null;
  const query = String(params.input?.query ?? "");
  const limit = typeof params.input?.limit === "number" && Number.isFinite(params.input.limit) ? Math.max(1, Math.min(20, params.input.limit)) : 5;
  const types = Array.isArray(params.input?.types) ? params.input.types.map((t: any) => String(t)).slice(0, 20) : null;

  if (!query) return { evidence: [], candidateCount: 0 };

  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "(expires_at IS NULL OR expires_at > now())"];
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (scope) {
    where.push(`scope = $${idx++}`);
    args.push(scope);
    if (scope === "user") {
      where.push(`owner_subject_id = $${idx++}`);
      args.push(params.subjectId);
    }
  }

  if (types?.length) {
    where.push(`type = ANY($${idx++}::text[])`);
    args.push(types);
  }

  where.push(`(content_text ILIKE $${idx} OR COALESCE(title,'') ILIKE $${idx})`);
  args.push(`%${query}%`);
  idx++;

  const res = await params.pool.query(
    `
      SELECT id, scope, type, title, content_text, created_at
      FROM memory_entries
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++}
    `,
    [...args, limit],
  );

  const evidence = res.rows.map((r: any) => {
    const snippetRaw = (r.title ? `${r.title}\n` : "") + String(r.content_text ?? "");
    const clipped = snippetRaw.slice(0, 280);
    const redacted = redactValue(clipped);
    return {
      id: r.id,
      type: r.type,
      scope: r.scope,
      title: r.title,
      snippet: String(redacted.value ?? ""),
      createdAt: r.created_at,
    };
  });

  return { evidence, candidateCount: evidence.length };
}

