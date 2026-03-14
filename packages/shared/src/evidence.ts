export type EvidenceSourceRef = {
  documentId: string;
  version: number;
  chunkId: string;
};

export type EvidenceRef = {
  retrievalLogId: string | null;
  sourceRef: EvidenceSourceRef;
  document: { title: string; sourceType: string };
  location: { chunkIndex: number; startOffset: number; endOffset: number };
  snippet: string;
  snippetDigest: { len: number; sha256_8: string };
};

export type EvidencePolicy = "required" | "optional" | "none";

export type AnswerEnvelope = {
  answer: string;
  evidencePolicy: EvidencePolicy;
  evidence?: EvidenceRef[];
  traceId?: string;
};

