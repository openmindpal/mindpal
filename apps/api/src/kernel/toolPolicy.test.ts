import { describe, expect, it } from "vitest";
import { isToolAllowedForPolicy } from "@mindpal/shared";

describe("tool policy matching", () => {
  it("accepts exact versioned tool refs", () => {
    expect(isToolAllowedForPolicy(["entity.create@1"], "entity.create@1")).toBe(true);
  });

  it("accepts unversioned tool names for resolved tool refs", () => {
    expect(isToolAllowedForPolicy(["entity.create"], "entity.create@7")).toBe(true);
    expect(isToolAllowedForPolicy(new Set(["knowledge.search"]), "knowledge.search@3")).toBe(true);
  });

  it("rejects different tool names", () => {
    expect(isToolAllowedForPolicy(["entity.create"], "entity.delete@1")).toBe(false);
  });

  it("treats empty allow lists as unrestricted", () => {
    expect(isToolAllowedForPolicy([], "entity.create@1")).toBe(true);
    expect(isToolAllowedForPolicy(null, "entity.create@1")).toBe(true);
  });
});
