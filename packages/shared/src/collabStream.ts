export type CollabStreamSignalKind = "state" | "event" | "envelope" | "status";

export type CollabStreamSignal = {
  collabRunId: string;
  tenantId: string;
  taskId?: string | null;
  kind: CollabStreamSignalKind;
  source: "api" | "worker";
  at: string;
};

export function collabStreamRedisChannel(collabRunId: string): string {
  return `collab:stream:${collabRunId}`;
}

export function createCollabStreamSignal(params: {
  collabRunId: string;
  tenantId: string;
  taskId?: string | null;
  kind: CollabStreamSignalKind;
  source: "api" | "worker";
}): CollabStreamSignal {
  return {
    collabRunId: String(params.collabRunId),
    tenantId: String(params.tenantId),
    taskId: params.taskId ?? null,
    kind: params.kind,
    source: params.source,
    at: new Date().toISOString(),
  };
}
