import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../../../lib/webhookVerification";
import {
  buildFederationHmacSignature,
  matchesFederationMtlsFingerprint,
  type FederationEnvelopeV1,
} from "./federationGateway";

function sampleEnvelope(): FederationEnvelopeV1 {
  return {
    format: "federation.envelope.v1",
    tenantId: "tenant_test",
    collabRunId: "run_123",
    correlationId: "corr_123",
    fromRole: "planner",
    toRole: "executor",
    kind: "proposal",
    payloadDigest: {
      nested: { b: 2, a: 1 },
      list: [3, 2, 1],
    },
  };
}

describe("federationGateway auth helpers", () => {
  it("generates HMAC signatures that match inbound verifier", () => {
    const envelope = sampleEnvelope();
    const secret = "shared-secret";
    const timestamp = "1712345678";
    const signature = buildFederationHmacSignature(secret, envelope, timestamp);

    const verified = verifyWebhookSignature({
      rawBody: JSON.stringify({
        collabRunId: "run_123",
        correlationId: "corr_123",
        format: "federation.envelope.v1",
        fromRole: "planner",
        kind: "proposal",
        payloadDigest: {
          list: [3, 2, 1],
          nested: { a: 1, b: 2 },
        },
        tenantId: "tenant_test",
        toRole: "executor",
      }),
      signature: `sha256=${signature}`,
      timestamp,
      config: {
        secret,
        signatureHeader: "x-federation-signature-256",
        timestampHeader: "x-federation-timestamp",
        toleranceSec: Number.MAX_SAFE_INTEGER,
        signatureScheme: "timestamp_body",
      },
    });

    expect(verified.valid).toBe(true);
  });

  it("matches mTLS fingerprints after normalization", () => {
    expect(matchesFederationMtlsFingerprint({
      allowedFingerprints: ["AA:BB:CC:DD"],
      presentedFingerprint: "aa-bb-cc-dd",
    })).toBe(true);

    expect(matchesFederationMtlsFingerprint({
      allowedFingerprints: ["00112233"],
      presentedFingerprint: "44556677",
    })).toBe(false);
  });
});
