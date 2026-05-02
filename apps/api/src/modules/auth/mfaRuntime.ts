/**
 * P1-04c: MFA / TOTP Runtime — RFC 6238 TOTP, Recovery Codes
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import { sha256Hex } from "@mindpal/shared";

/* ─── TOTP (RFC 6238 / RFC 4226) ─── */

const TOTP_PERIOD = 30; // seconds
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // allow ±1 period drift

/**
 * Generate a random TOTP secret (160-bit, base32-encoded).
 */
export function generateTotpSecret(): string {
  const buf = crypto.randomBytes(20);
  return base32Encode(buf);
}

/**
 * Build an otpauth:// URI for enrollment QR codes.
 */
export function buildTotpUri(params: { secret: string; accountName: string; issuer?: string }): string {
  const issuer = params.issuer ?? "OpenSlin";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.accountName)}`;
  return `otpauth://totp/${label}?secret=${params.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

/**
 * Compute the TOTP value for a given time step.
 */
function hotpValue(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a TOTP code against a base32-encoded secret.
 * Returns `true` if the code is valid within ±TOTP_WINDOW periods.
 */
export function verifyTotp(secret: string, code: string): boolean {
  if (!code || code.length !== TOTP_DIGITS) return false;
  const secretBuf = base32Decode(secret);
  const now = Math.floor(Date.now() / 1000);
  const currentStep = BigInt(Math.floor(now / TOTP_PERIOD));
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const step = currentStep + BigInt(i);
    if (hotpValue(secretBuf, step) === code) return true;
  }
  return false;
}

/* ─── Recovery Codes ─── */

const RECOVERY_CODE_COUNT = 10;

/**
 * Generate a set of recovery codes (plain text + hashed).
 */
export function generateRecoveryCodes(): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8-char hex
    plain.push(code);
    hashed.push(sha256Hex(code));
  }
  return { plain, hashed };
}

/* ─── DB Persistence ─── */

export type MfaEnrollmentRow = {
  id: string;
  tenantId: string;
  subjectId: string;
  method: "totp";
  secretEnc: string;       // stored encrypted (application should use master-key envelope in production)
  recoveryCodes: string[];  // hashed
  verified: boolean;
  createdAt: string;
  updatedAt: string;
};

function toMfaRow(r: any): MfaEnrollmentRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    subjectId: String(r.subject_id),
    method: "totp",
    secretEnc: String(r.secret_enc),
    recoveryCodes: Array.isArray(r.recovery_codes) ? r.recovery_codes : JSON.parse(r.recovery_codes ?? "[]"),
    verified: Boolean(r.verified),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function getMfaEnrollment(params: { pool: Pool; tenantId: string; subjectId: string }): Promise<MfaEnrollmentRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM mfa_enrollments WHERE tenant_id = $1 AND subject_id = $2 LIMIT 1",
    [params.tenantId, params.subjectId],
  );
  if (!res.rowCount) return null;
  return toMfaRow(res.rows[0]);
}

export async function upsertMfaEnrollment(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  secretEnc: string;
  recoveryCodes: string[];
}): Promise<MfaEnrollmentRow> {
  const res = await params.pool.query(
    `INSERT INTO mfa_enrollments (tenant_id, subject_id, method, secret_enc, recovery_codes, verified)
     VALUES ($1, $2, 'totp', $3, $4::jsonb, false)
     ON CONFLICT (tenant_id, subject_id) DO UPDATE
       SET secret_enc = EXCLUDED.secret_enc,
           recovery_codes = EXCLUDED.recovery_codes,
           verified = false,
           updated_at = now()
     RETURNING *`,
    [params.tenantId, params.subjectId, params.secretEnc, JSON.stringify(params.recoveryCodes)],
  );
  return toMfaRow(res.rows[0]);
}

export async function confirmMfaEnrollment(params: { pool: Pool; tenantId: string; subjectId: string }): Promise<boolean> {
  const res = await params.pool.query(
    "UPDATE mfa_enrollments SET verified = true, updated_at = now() WHERE tenant_id = $1 AND subject_id = $2 AND verified = false RETURNING id",
    [params.tenantId, params.subjectId],
  );
  return Boolean(res.rowCount);
}

export async function deleteMfaEnrollment(params: { pool: Pool; tenantId: string; subjectId: string }): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM mfa_enrollments WHERE tenant_id = $1 AND subject_id = $2",
    [params.tenantId, params.subjectId],
  );
  return Boolean(res.rowCount);
}

/**
 * Consume a recovery code — marks it as used (removes from the set).
 * Returns true if the code was valid and consumed.
 */
export async function consumeRecoveryCode(params: { pool: Pool; tenantId: string; subjectId: string; code: string }): Promise<boolean> {
  const enrollment = await getMfaEnrollment(params);
  if (!enrollment || !enrollment.verified) return false;
  const codeHash = sha256Hex(params.code.toUpperCase().trim());
  const idx = enrollment.recoveryCodes.indexOf(codeHash);
  if (idx < 0) return false;

  /* Remove used code */
  const updated = [...enrollment.recoveryCodes];
  updated.splice(idx, 1);
  await params.pool.query(
    "UPDATE mfa_enrollments SET recovery_codes = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND subject_id = $2",
    [params.tenantId, params.subjectId, JSON.stringify(updated)],
  );
  return true;
}

/* ─── Base32 Encoding / Decoding (RFC 4648) ─── */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
