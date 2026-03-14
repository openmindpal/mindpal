import { Queue } from "bullmq";
import type { ApiConfig } from "../../config";
import { attachJobTraceCarrier } from "../../lib/tracing";

export type WorkflowQueue = Queue;

export function createWorkflowQueue(cfg: ApiConfig) {
  const connection = { host: cfg.redis.host, port: cfg.redis.port };
  const q = new Queue("workflow", { connection });
  const origAdd = q.add.bind(q);
  (q as any).add = (name: string, data: any, opts: any) => origAdd(name, attachJobTraceCarrier(data ?? {}), opts);
  return q;
}
