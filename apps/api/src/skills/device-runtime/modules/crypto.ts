import crypto from "node:crypto";

export { sha256Hex } from "@mindpal/shared";

export function randomCode(prefix: string) {
  return `${prefix}${crypto.randomBytes(24).toString("base64url")}`;
}

