/**
 * Device-Agent SDK 内核日志工具
 *
 * 从 @openslin/shared 复用 sha256_8 与 StructuredLogger，
 * 提供与原 apps/device-agent/src/log.ts 相同的接口，
 * 使内核模块可独立于应用层运行。
 *
 * @layer kernel
 */
import { StructuredLogger, sha256_8 } from "@openslin/shared";

export { sha256_8 };

export const deviceLogger = new StructuredLogger({ module: "device-agent-sdk" });

export function safeLog(message: string) {
  deviceLogger.info(message);
}

export function safeError(message: string) {
  deviceLogger.error(message);
}
