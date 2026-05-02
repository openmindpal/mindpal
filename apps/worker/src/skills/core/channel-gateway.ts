import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { tickWebhookDeliveries } from "../../channels/webhookDelivery";
import { tickChannelOutboxDeliveries } from "../../channels/outboxDelivery";
import { resolveString } from "@mindpal/shared";

function resolveMasterKey() {
  const v = resolveString("API_MASTER_KEY").value;
  if (v) return v;
  if (process.env.NODE_ENV === "production") return "";
  return "dev-master-key-change-me";
}

export const channelGatewayWorker: WorkerSkillContribution = {
  skillName: "channel.gateway",
  tickers: [
    { name: "channel.webhook.delivery", intervalMs: 2_000, tick: async ({ pool }) => { await tickWebhookDeliveries({ pool }); } },
    { name: "channel.outbox.delivery", intervalMs: 2_000, tick: async ({ pool }) => { await tickChannelOutboxDeliveries({ pool, masterKey: resolveMasterKey() }); } },
  ],
};
