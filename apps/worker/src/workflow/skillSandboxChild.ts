/**
 * skillSandboxChild.ts — Worker 侧 Skill 沙箱子进程
 *
 * 使用 @openslin/shared 的统一沙箱执行流程。
 * Worker 特有：进程隔离（fork 模式），由 SkillProcessPool 管理。
 * @see packages/shared/src/skillExecutor.ts
 */
import {
  runSkillEntry,
  SANDBOX_FORBIDDEN_MODULES_DATABASE,
} from "@openslin/shared";
import type { SandboxIpcPayload, SandboxIpcResultMessage } from "@openslin/shared";

async function main() {
  process.on("message", async (m: any) => {
    if (!m || typeof m !== "object") return;
    if (m.type !== "execute") return;
    const payload: SandboxIpcPayload = m.payload ?? {};

    const result = await runSkillEntry({
      payload,
      // Worker 侧额外禁止数据库模块
      extraForbiddenModules: SANDBOX_FORBIDDEN_MODULES_DATABASE,
    });

    const msg: SandboxIpcResultMessage = {
      type: "result",
      ok: result.ok,
      output: result.output,
      error: result.error,
      depsDigest: result.depsDigest,
      egress: result.egress,
    };
    (process as any).send?.(msg);
  });
}

void main();
