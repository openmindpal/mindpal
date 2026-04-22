import { sha256Hex, stableStringify } from "@openslin/shared";

export { sha256Hex, stableStringify };

export function jsonByteLength(v: unknown) {
  try {
    const s = JSON.stringify(v);
    return Buffer.byteLength(s, "utf8");
  } catch {
    return 0;
  }
}

