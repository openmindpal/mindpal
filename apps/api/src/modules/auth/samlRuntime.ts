/**
 * SAML Runtime — architecture-05 section 15.15
 * Handles: SAML Assertion parsing, signature verification, claim mapping.
 *
 * 功能目标：实现企业级SAML 2.0身份提供者集成，支持SP-Initiated SSO流程。
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import type { SsoProviderConfigRow } from "./ssoScimRepo";
import { ensureSubject } from "./subjectRepo";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "samlRuntime" });

/* ─── SAML Types ─── */

export interface SamlAssertion {
  issuer: string;
  subject: {
    nameId: string;
    nameIdFormat: string;
  };
  conditions?: {
    notBefore?: string;
    notOnOrAfter?: string;
    audience?: string;
  };
  authnStatement?: {
    authnInstant?: string;
    sessionIndex?: string;
  };
  attributes: Record<string, string[]>;
  inResponseTo?: string;
}

export interface SamlResponse {
  id: string;
  issuer: string;
  status: {
    code: string;
    message?: string;
  };
  assertion?: SamlAssertion;
  signedXml?: string;
}

/* ─── XML Parsing Helpers ─── */

/**
 * 从SAML Response XML中提取关键字段。
 * 注：生产环境应使用成熟的XML解析库（如fast-xml-parser）。
 * 此处为最小可行实现，支持常见IdP格式。
 */
function extractTagContent(xml: string, tagName: string, namespace?: string): string | null {
  const nsPattern = namespace ? `(?:${namespace}:)?` : "";
  const regex = new RegExp(`<${nsPattern}${tagName}[^>]*>([^<]*)</${nsPattern}${tagName}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim() || null;
}

function extractTagAttribute(xml: string, tagName: string, attrName: string): string | null {
  const tagRegex = new RegExp(`<(?:\\w+:)?${tagName}[^>]+${attrName}="([^"]*)"`, "i");
  const match = xml.match(tagRegex);
  return match?.[1] || null;
}

function extractAllAttributes(assertionXml: string): Record<string, string[]> {
  const attrs: Record<string, string[]> = {};
  // Match SAML Attribute elements
  const attrRegex = /<(?:\w+:)?Attribute\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?Attribute>/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(assertionXml)) !== null) {
    const name = match[1];
    const attrContent = match[2];
    // Extract AttributeValue elements
    const valueRegex = /<(?:\w+:)?AttributeValue[^>]*>([^<]*)<\/(?:\w+:)?AttributeValue>/gi;
    const values: string[] = [];
    let valueMatch: RegExpExecArray | null;
    while ((valueMatch = valueRegex.exec(attrContent)) !== null) {
      values.push(valueMatch[1].trim());
    }
    if (values.length > 0) {
      attrs[name] = values;
    }
  }
  return attrs;
}

/* ─── SAML Response Parsing ─── */

export function parseSamlResponse(base64Response: string): SamlResponse {
  const xml = Buffer.from(base64Response, "base64").toString("utf-8");

  // Extract Response-level fields
  const responseId = extractTagAttribute(xml, "Response", "ID") || "";
  const issuer = extractTagContent(xml, "Issuer", "saml") || extractTagContent(xml, "Issuer") || "";
  const statusCode = extractTagAttribute(xml, "StatusCode", "Value") || "";
  const inResponseTo = extractTagAttribute(xml, "Response", "InResponseTo");

  // Normalize status code (strip namespace prefix)
  const normalizedStatus = statusCode.split(":").pop() || statusCode;

  // Extract Assertion if present
  let assertion: SamlAssertion | undefined;
  const assertionMatch = xml.match(/<(?:\w+:)?Assertion[\s\S]+?<\/(?:\w+:)?Assertion>/i);
  if (assertionMatch) {
    const assertionXml = assertionMatch[0];
    const assertionIssuer = extractTagContent(assertionXml, "Issuer") || issuer;

    // Extract Subject/NameID
    const nameId = extractTagContent(assertionXml, "NameID") || "";
    const nameIdFormat = extractTagAttribute(assertionXml, "NameID", "Format") || "";

    // Extract Conditions
    const notBefore = extractTagAttribute(assertionXml, "Conditions", "NotBefore");
    const notOnOrAfter = extractTagAttribute(assertionXml, "Conditions", "NotOnOrAfter");
    const audienceXml = assertionXml.match(/<(?:\w+:)?AudienceRestriction[\s\S]*?<\/(?:\w+:)?AudienceRestriction>/i);
    const audience = audienceXml ? extractTagContent(audienceXml[0], "Audience") : null;

    // Extract AuthnStatement
    const authnInstant = extractTagAttribute(assertionXml, "AuthnStatement", "AuthnInstant");
    const sessionIndex = extractTagAttribute(assertionXml, "AuthnStatement", "SessionIndex");

    // Extract Attributes
    const attributes = extractAllAttributes(assertionXml);

    assertion = {
      issuer: assertionIssuer,
      subject: { nameId, nameIdFormat },
      conditions: { notBefore: notBefore || undefined, notOnOrAfter: notOnOrAfter || undefined, audience: audience || undefined },
      authnStatement: { authnInstant: authnInstant || undefined, sessionIndex: sessionIndex || undefined },
      attributes,
      inResponseTo: inResponseTo || undefined,
    };
  }

  return {
    id: responseId,
    issuer,
    status: { code: normalizedStatus },
    assertion,
    signedXml: xml,
  };
}

/* ─── Signature Verification ─── */

/**
 * 验证SAML Response签名。
 * 注：完整实现需支持多种签名算法和证书格式。
 * 此处为基础RSA-SHA256验证。
 */
export function verifySamlSignature(xml: string, certificate: string): boolean {
  try {
    // Extract SignedInfo and SignatureValue
    const signedInfoMatch = xml.match(/<(?:\w+:)?SignedInfo[\s\S]*?<\/(?:\w+:)?SignedInfo>/i);
    const signatureValueMatch = xml.match(/<(?:\w+:)?SignatureValue[^>]*>([^<]+)<\/(?:\w+:)?SignatureValue>/i);

    if (!signedInfoMatch || !signatureValueMatch) {
            _logger.warn("Missing SignedInfo or SignatureValue");
      return false;
    }

    const signedInfo = signedInfoMatch[0];
    const signatureValue = signatureValueMatch[1].replace(/\s/g, "");
    const signatureBuffer = Buffer.from(signatureValue, "base64");

    // Canonicalize SignedInfo (simplified - production should use xml-c14n)
    const canonicalizedSignedInfo = signedInfo
      .replace(/\r\n/g, "\n")
      .replace(/\n\s*/g, "")
      .trim();

    // Prepare certificate
    const certPem = certificate.includes("BEGIN CERTIFICATE")
      ? certificate
      : `-----BEGIN CERTIFICATE-----\n${certificate}\n-----END CERTIFICATE-----`;

    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(canonicalizedSignedInfo);
    return verifier.verify(certPem, signatureBuffer);
  } catch (err) {
        _logger.error("Signature verification error", { err: (err as Error)?.message });
    return false;
  }
}

/* ─── Assertion Validation ─── */

export function validateSamlAssertion(params: {
  assertion: SamlAssertion;
  expectedIssuer: string;
  expectedAudience: string;
  allowedClockSkewMs?: number;
}): { valid: boolean; error?: string } {
  const { assertion, expectedIssuer, expectedAudience, allowedClockSkewMs = 300_000 } = params;

  // Validate issuer
  if (assertion.issuer !== expectedIssuer) {
    return { valid: false, error: `Issuer mismatch: expected ${expectedIssuer}, got ${assertion.issuer}` };
  }

  // Validate audience (if present)
  if (assertion.conditions?.audience && assertion.conditions.audience !== expectedAudience) {
    return { valid: false, error: `Audience mismatch: expected ${expectedAudience}, got ${assertion.conditions.audience}` };
  }

  // Validate time conditions
  const now = Date.now();
  if (assertion.conditions?.notBefore) {
    const notBefore = new Date(assertion.conditions.notBefore).getTime();
    if (now < notBefore - allowedClockSkewMs) {
      return { valid: false, error: "Assertion not yet valid (NotBefore)" };
    }
  }
  if (assertion.conditions?.notOnOrAfter) {
    const notOnOrAfter = new Date(assertion.conditions.notOnOrAfter).getTime();
    if (now > notOnOrAfter + allowedClockSkewMs) {
      return { valid: false, error: "Assertion expired (NotOnOrAfter)" };
    }
  }

  // Validate NameID presence
  if (!assertion.subject.nameId) {
    return { valid: false, error: "Missing NameID in assertion" };
  }

  return { valid: true };
}

/* ─── Claim Mapping ─── */

export function mapSamlClaims(
  assertion: SamlAssertion,
  mappings: Record<string, string>
): { subjectId: string; email: string | null; displayName: string | null } {
  // Default claim mappings for common IdPs
  const subField = mappings.sub || mappings.subjectId || "NameID";
  const emailField = mappings.email || "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
  const nameField = mappings.name || "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";

  // Get subjectId: prefer NameID, fallback to attribute
  let subjectId = "";
  if (subField === "NameID" || subField === "nameId") {
    subjectId = assertion.subject.nameId;
  } else {
    subjectId = assertion.attributes[subField]?.[0] || assertion.subject.nameId;
  }

  // Get email
  const email = assertion.attributes[emailField]?.[0] || null;

  // Get display name
  const displayName = assertion.attributes[nameField]?.[0] || null;

  if (!subjectId) {
    throw new Error("Cannot extract subjectId from SAML assertion");
  }

  return { subjectId, email, displayName };
}

/* ─── SAML Login State ─── */

export async function createSamlLoginState(params: {
  pool: Pool;
  tenantId: string;
  providerId: string;
  requestId: string;
  relayState?: string;
  ttlSeconds?: number;
}) {
  const ttl = params.ttlSeconds ?? 600;
  await params.pool.query(
    `INSERT INTO sso_login_states (tenant_id, provider_id, state, nonce, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)
     ON CONFLICT (state) DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at`,
    [params.tenantId, params.providerId, params.requestId, params.relayState || "", "", String(ttl)],
  );
  return { requestId: params.requestId };
}

export async function consumeSamlLoginState(params: { pool: Pool; requestId: string }) {
  const res = await params.pool.query(
    `DELETE FROM sso_login_states WHERE state = $1 AND expires_at > now() RETURNING *`,
    [params.requestId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    tenantId: String(r.tenant_id),
    providerId: String(r.provider_id),
    relayState: String(r.nonce || ""),
  };
}

/* ─── Build SAML AuthnRequest ─── */

export function buildSamlAuthnRequest(params: {
  provider: SsoProviderConfigRow;
  assertionConsumerServiceUrl: string;
  requestId: string;
  relayState?: string;
}): { authnRequestXml: string; authnRequestBase64: string } {
  const issueInstant = new Date().toISOString();
  // SP Entity ID (audience for the IdP) - use redirect_uri or a configured value
  const spEntityId = params.provider.redirectUri || params.assertionConsumerServiceUrl;

  const authnRequestXml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest
    xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="_${params.requestId}"
    Version="2.0"
    IssueInstant="${issueInstant}"
    Destination="${params.provider.issuerUrl}"
    AssertionConsumerServiceURL="${params.assertionConsumerServiceUrl}"
    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${spEntityId}</saml:Issuer>
  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>
</samlp:AuthnRequest>`;

  const authnRequestBase64 = Buffer.from(authnRequestXml).toString("base64");

  return { authnRequestXml, authnRequestBase64 };
}

/* ─── Auto-Provision SAML User ─── */

export async function autoProvisionSamlUser(params: {
  pool: Pool;
  tenantId: string;
  provider: SsoProviderConfigRow;
  subjectId: string;
  email: string | null;
  displayName: string | null;
}) {
  await ensureSubject({ pool: params.pool, tenantId: params.tenantId, subjectId: params.subjectId });

  // Link identity
  await params.pool.query(
    `INSERT INTO subject_identity_links (tenant_id, primary_subject_id, linked_subject_id, identity_label, provider_type, provider_ref)
     VALUES ($1, $2, $2, 'saml', 'saml', $3)
     ON CONFLICT (tenant_id, primary_subject_id, linked_subject_id) DO UPDATE SET updated_at = now()`,
    [params.tenantId, params.subjectId, params.provider.providerId],
  );

  // Assign default role if configured
  if (params.provider.defaultRoleId) {
    await params.pool.query(
      `INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id)
       VALUES ($1, $2, 'tenant', $3)
       ON CONFLICT DO NOTHING`,
      [params.subjectId, params.provider.defaultRoleId, params.tenantId],
    );
  }
}
