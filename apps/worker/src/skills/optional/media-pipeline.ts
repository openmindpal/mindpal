import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { processMediaJob } from "../../media/processor";

export const mediaPipelineWorker: WorkerSkillContribution = {
  skillName: "media.pipeline",
  jobs: [
    {
      kind: "media.process",
      process: async ({ pool, data }) => {
        const fsRootDir = String(process.env.MEDIA_FS_ROOT_DIR ?? "").trim() || "var/media";
        await processMediaJob({ pool, tenantId: String(data.tenantId), jobId: String(data.jobId), fsRootDir });
      },
    },
  ],
};
