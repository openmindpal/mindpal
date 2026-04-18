import { describe, expect, it, vi } from "vitest";
import { detectAndBoostStarvedProcesses } from "./priorityScheduler";
import { expireStaleCheckpoints, findExpiredCheckpoints } from "./loopCheckpoint";

describe("loop SQL interval safety", () => {
  it("findExpiredCheckpoints uses explicit bigint interval cast", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = { query } as any;

    await findExpiredCheckpoints(pool);

    const sql = String(((query.mock.calls[0] as unknown as any[] | undefined)?.[0]) ?? "");
    expect(sql).toContain("$1::bigint * interval '1 millisecond'");
  });

  it("expireStaleCheckpoints uses explicit bigint interval cast", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = { query } as any;

    await expireStaleCheckpoints(pool);

    const sql = String(((query.mock.calls[0] as unknown as any[] | undefined)?.[0]) ?? "");
    expect(sql).toContain("$1::bigint * interval '1 millisecond'");
  });

  it("detectAndBoostStarvedProcesses uses explicit bigint interval cast", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = { query } as any;

    await detectAndBoostStarvedProcesses({ pool });

    const sql = String(((query.mock.calls[0] as unknown as any[] | undefined)?.[0]) ?? "");
    expect(sql).toContain("$2::bigint * interval '1 millisecond'");
  });
});
