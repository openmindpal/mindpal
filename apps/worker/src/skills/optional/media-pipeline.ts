import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { processMediaJob } from "../../media/processor";
import { resolveString } from "@openslin/shared";

export const mediaPipelineWorker: WorkerSkillContribution = {
  skillName: "media.pipeline",
  jobs: [
    {
      kind: "media.process",
      process: async ({ pool, data }) => {
        const fsRootDir = resolveString("MEDIA_FS_ROOT_DIR").value || "var/media";
        await processMediaJob({ pool, tenantId: String(data.tenantId), jobId: String(data.jobId), fsRootDir });
      },
    },
  ],
};
