import crypto from "node:crypto";

export { sha256Hex } from "@openslin/shared";

export function randomCode(prefix: string) {
  return `${prefix}${crypto.randomBytes(24).toString("base64url")}`;
}

