import { StructuredLogger, sha256_8 } from "@openslin/shared";

export { sha256_8 };

export const deviceLogger = new StructuredLogger({ module: "device-agent" });

export function safeLog(message: string) {
  deviceLogger.info(message);
}

export function safeError(message: string) {
  deviceLogger.error(message);
}
