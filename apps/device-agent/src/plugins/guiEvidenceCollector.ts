/**
 * GUI Evidence Collector — 失败截图捕获与证据上传
 *
 * 从 guiAutomationPlugin.ts 拆出，集中管理证据采集逻辑。
 */

import { apiPostJson } from "@mindpal/device-agent-sdk";
import {
  captureScreen,
  cleanupCapture,
  type ScreenCapture,
} from "./localVision";

/** 证据上传配置 */
export interface EvidenceUploadConfig {
  apiBase: string;
  deviceToken: string;
  deviceExecutionId: string;
}

/**
 * 失败时截图并上传证据
 * @returns evidenceRef（如有），上传失败返回 null
 */
export async function captureAndUploadEvidence(
  cfg: EvidenceUploadConfig,
  label: string,
): Promise<string | null> {
  let errCapture: ScreenCapture | undefined;
  try {
    errCapture = await captureScreen();
    const buf = await import("node:fs/promises").then((f) => f.readFile(errCapture!.filePath));
    const base64 = buf.toString("base64");
    const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
      apiBase: cfg.apiBase,
      path: "/device-agent/evidence/upload",
      token: cfg.deviceToken,
      body: {
        deviceExecutionId: cfg.deviceExecutionId,
        contentBase64: base64,
        contentType: "image/png",
        format: "png",
        label,
      },
    });
    return up.json?.evidenceRef ?? null;
  } catch {
    /* 证据上传失败不影响主流程 */
    return null;
  } finally {
    if (errCapture) await cleanupCapture(errCapture);
  }
}

/**
 * 截图并上传为完整证据（用于 device.gui.screenshot 工具）
 */
export async function screenshotAndUpload(
  cfg: EvidenceUploadConfig,
): Promise<{ status: number; artifactId?: string; evidenceRef?: string }> {
  const capture = await captureScreen();
  try {
    const buf = await import("node:fs/promises").then((f) => f.readFile(capture.filePath));
    const base64 = buf.toString("base64");
    const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
      apiBase: cfg.apiBase,
      path: "/device-agent/evidence/upload",
      token: cfg.deviceToken,
      body: {
        deviceExecutionId: cfg.deviceExecutionId,
        contentBase64: base64,
        contentType: "image/png",
        format: "png",
      },
    });
    return {
      status: up.status,
      artifactId: up.json?.artifactId,
      evidenceRef: up.json?.evidenceRef,
    };
  } finally {
    await cleanupCapture(capture);
  }
}
