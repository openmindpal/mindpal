import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { tickSubscriptions } from "../../subscriptions/ticker";
import { resolveString } from "@openslin/shared";

function resolveMasterKey() {
  const v = resolveString("API_MASTER_KEY").value;
  if (v) return v;
  if (process.env.NODE_ENV === "production") return "";
  return "dev-master-key-change-me";
}

export const subscriptionRunnerWorker: WorkerSkillContribution = {
  skillName: "subscription.runner",
  tickers: [
    { name: "subscription.tick", intervalMs: 5_000, tick: async ({ pool }) => { await tickSubscriptions({ pool, masterKey: resolveMasterKey() }); } },
  ],
};
