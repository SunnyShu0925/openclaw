// Regression coverage for bounded claim work: chunked candidate membership must
// not re-read the whole backlog under the SQLite write lock on every claim.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as kyselySync from "../../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-queue-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createTestIngressQueue<TPayload>(stateDir: string) {
  return createChannelIngressQueue<TPayload>({
    channelId: "test",
    accountId: "account",
    stateDir,
  });
}

// Spy on the shared sync executor to observe the SQL compiled for each
// channel_ingress_events select. The shard runs non-isolated, so module-level
// mocks do not reliably intercept already-loaded importers; the live binding is
// observed by replacing the exported function the queue calls.
function observeSelectSql(): {
  spy: ReturnType<typeof vi.spyOn>;
  selectSqls: string[];
} {
  const originalExecute = kyselySync.executeSqliteQuerySync;
  const selectSqls: string[] = [];
  const wrappedExecute = (
    db: Parameters<typeof originalExecute>[0],
    query: Parameters<typeof originalExecute>[1],
  ) => {
    const result = originalExecute(db, query);
    if (typeof query.compile === "function") {
      const sql = query.compile().sql;
      if (sql.includes("channel_ingress_events") && sql.includes("select")) {
        selectSqls.push(sql);
      }
    }
    return result;
  };
  const spy = vi.spyOn(kyselySync, "executeSqliteQuerySync").mockImplementation(wrappedExecute);
  return { spy, selectSqls };
}

describe("channel ingress queue claim bounds", () => {
  it("bounds per-chunk candidate reads to the claim scan limit", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ lane: string }>(stateDir);
      const ids = Array.from({ length: 1_001 }, (_, index) => `blocked-${index}`);
      for (const [index, id] of ids.entries()) {
        await queue.enqueue(id, { lane: "blocked" }, { laneKey: "blocked", receivedAt: index + 1 });
      }

      const originalExecute = kyselySync.executeSqliteQuerySync;
      const chunkRowCounts: number[] = [];
      const wrappedExecute = (
        db: Parameters<typeof originalExecute>[0],
        query: Parameters<typeof originalExecute>[1],
      ) => {
        const result = originalExecute(db, query);
        if (typeof query.compile === "function") {
          const sql = query.compile().sql;
          if (sql.includes("channel_ingress_events") && sql.includes("limit ?")) {
            chunkRowCounts.push(result.rows.length);
          }
        }
        return result;
      };
      const spy = vi.spyOn(kyselySync, "executeSqliteQuerySync").mockImplementation(wrappedExecute);

      try {
        const claimed = await queue.claimNext({
          ownerId: "worker",
          candidateIds: ids,
          blockedLaneKeys: ["blocked"],
          deriveLaneKey: (record) => record.payload.lane,
          scanLimit: 100,
        });

        expect(claimed).toBeNull();
        expect(chunkRowCounts.length).toBeGreaterThan(0);
        expect(Math.max(...chunkRowCounts)).toBeLessThanOrEqual(100);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("drops the blocked-lane SQL predicate above the bind-variable budget", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // A single claimable row on the "free" lane, plus a candidate snapshot
      // that also names one blocked row. blockedLaneKeys carries 30_000 distinct
      // stored lanes (above CLAIM_BLOCKED_LANE_PREDICATE_LIMIT ~ 28_990) without
      // a deriveLaneKey, so the claim takes the stored-lane SQL path and the
      // NOT IN predicate is dropped to stay under SQLite's bind ceiling.
      await queue.enqueue("free", { text: "free" }, { laneKey: "free", receivedAt: 1 });
      await queue.enqueue("blocked", { text: "blocked" }, { laneKey: "blocked", receivedAt: 2 });
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );

      const { spy, selectSqls } = observeSelectSql();
      try {
        const claimed = await queue.claimNext({
          ownerId: "worker",
          candidateIds: ["free", "blocked"],
          blockedLaneKeys: oversizedBlockedLaneKeys,
        });

        // The claim must not throw "too many SQL variables"; the in-memory
        // effectiveBlocked.has(laneKey) scan gate still excludes "blocked".
        expect(claimed?.id).toBe("free");
        // The candidate-branch select that filters pending rows must omit the
        // NOT IN predicate once the blocked set exceeds the bind budget.
        const candidateSelects = selectSqls.filter(
          (sql) => sql.includes("status") && sql.includes("event_id"),
        );
        expect(candidateSelects.length).toBeGreaterThan(0);
        for (const sql of candidateSelects) {
          expect(sql).not.toContain("not in");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("claims a free row past a blocked prefix above the bind-variable budget", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // 100 blocked rows fill the scanLimit window (LINE's default), each on its
      // own stored lane, followed by one free row at position 101. blockedLaneKeys
      // carries 30_000 distinct lanes so the SQL NOT IN predicate is dropped;
      // without the in-memory skip-not-counting fix, the 100 blocked rows would
      // consume the scanLimit budget and the free row at 101 would starve.
      for (let index = 0; index < 100; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
      }
      await queue.enqueue("free", { text: "free" }, { laneKey: "free", receivedAt: 101 });
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );
      // Ensure every blocked row's lane is in the blocked set, plus the free
      // lane is not.
      for (let index = 0; index < 100; index += 1) {
        oversizedBlockedLaneKeys[index] = `blocked-lane-${index}`;
      }

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds: [...Array.from({ length: 100 }, (_, index) => `blocked-${index}`), "free"],
        blockedLaneKeys: oversizedBlockedLaneKeys,
        scanLimit: 100,
      });

      // The free row behind the 100-row blocked prefix must still be claimed;
      // blocked rows are skipped in memory without consuming the scan budget.
      expect(claimed?.id).toBe("free");
    });
  });

  it("keeps the blocked-lane SQL predicate below the bind-variable budget", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("free", { text: "free" }, { laneKey: "free", receivedAt: 1 });
      await queue.enqueue("blocked", { text: "blocked" }, { laneKey: "blocked", receivedAt: 2 });

      const { spy, selectSqls } = observeSelectSql();
      try {
        const claimed = await queue.claimNext({
          ownerId: "worker",
          candidateIds: ["free", "blocked"],
          blockedLaneKeys: ["blocked"],
        });

        expect(claimed?.id).toBe("free");
        // A small blocked set stays inside the bind budget, so the SQL
        // predicate is still compiled to prune blocked lanes before the scan.
        const candidateSelects = selectSqls.filter(
          (sql) => sql.includes("status") && sql.includes("event_id"),
        );
        expect(candidateSelects.length).toBeGreaterThan(0);
        expect(candidateSelects.some((sql) => sql.includes("not in"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("claims a free row past a blocked prefix below the bind-variable budget", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // Same blocked-prefix shape as the oversized case, but with a small blocked
      // set so the SQL NOT IN predicate is retained and prunes blocked rows in
      // SQL before they reach the scan loop.
      for (let index = 0; index < 100; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: "blocked-lane", receivedAt: index + 1 },
        );
      }
      await queue.enqueue("free", { text: "free" }, { laneKey: "free", receivedAt: 101 });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds: [...Array.from({ length: 100 }, (_, index) => `blocked-${index}`), "free"],
        blockedLaneKeys: ["blocked-lane"],
        scanLimit: 100,
      });

      // SQL prunes the 100 blocked rows; the free row is the first returned.
      expect(claimed?.id).toBe("free");
    });
  });

  it("drops the blocked-lane SQL predicate above the budget without candidate ids", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // No candidateIds: the claim takes the non-candidate else branch, which
      // selects pending rows directly. 30,000 blockedLaneKeys exceed
      // CLAIM_BLOCKED_LANE_PREDICATE_LIMIT (~28,990) with no deriveLaneKey, so
      // the SQL NOT IN predicate is dropped to stay under the bind ceiling.
      await queue.enqueue("free", { text: "free" }, { laneKey: "free", receivedAt: 1 });
      await queue.enqueue("blocked", { text: "blocked" }, { laneKey: "blocked", receivedAt: 2 });
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );

      const { spy, selectSqls } = observeSelectSql();
      try {
        const claimed = await queue.claimNext({
          ownerId: "worker",
          blockedLaneKeys: oversizedBlockedLaneKeys,
        });

        // The claim must not throw "too many SQL variables"; the in-memory
        // effectiveBlocked.has(laneKey) scan gate still excludes "blocked".
        expect(claimed?.id).toBe("free");
        // The non-candidate select has no event_id IN membership clause (it
        // still orders by event_id, so filter on the IN membership, not the
        // column name). It must omit the NOT IN predicate once the blocked set
        // exceeds the bind budget.
        const nonCandidateSelects = selectSqls.filter((sql) => !sql.includes('"event_id" in'));
        expect(nonCandidateSelects.length).toBeGreaterThan(0);
        for (const sql of nonCandidateSelects) {
          expect(sql).not.toContain("not in");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("claims a free row past a blocked prefix above the budget without candidate ids", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // 100 blocked rows fill the scanLimit window, each on its own stored lane,
      // followed by one free row at position 101. No candidateIds and 30,000
      // blockedLaneKeys: the non-candidate branch drops the SQL NOT IN predicate
      // and must widen its SQL limit so the free row behind the prefix is reached
      // and skipped blocked rows do not consume the scan budget.
      for (let index = 0; index < 100; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
      }
      await queue.enqueue("free", { text: "free" }, { laneKey: "free", receivedAt: 101 });
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );
      for (let index = 0; index < 100; index += 1) {
        oversizedBlockedLaneKeys[index] = `blocked-lane-${index}`;
      }

      const claimed = await queue.claimNext({
        ownerId: "worker",
        blockedLaneKeys: oversizedBlockedLaneKeys,
        scanLimit: 100,
      });

      // The free row behind the 100-row blocked prefix must still be claimed;
      // the widened SQL limit returned it and blocked rows were skipped in
      // memory without consuming the scan budget.
      expect(claimed?.id).toBe("free");
    });
  });

  it("claims a free row past a cap-plus-one blocked prefix with candidate ids", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // CLAIM_DEGRADED_BLOCKED_SCAN_CAP (10,000) rows per degraded page. Enqueue
      // cap-plus-one blocked rows so the first page is entirely blocked and the
      // free row sits one past the page boundary, then a free row. Under the
      // round-2 hard cap the scan stopped at 10,000 blocked rows and returned
      // null; the keyset continuation must advance the cursor and reach it.
      const blockedCount = 10_001;
      for (let index = 0; index < blockedCount; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
      }
      await queue.enqueue(
        "free",
        { text: "free" },
        { laneKey: "free", receivedAt: blockedCount + 1 },
      );
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );
      for (let index = 0; index < blockedCount; index += 1) {
        oversizedBlockedLaneKeys[index] = `blocked-lane-${index}`;
      }
      const candidateIds = [
        ...Array.from({ length: blockedCount }, (_, index) => `blocked-${index}`),
        "free",
      ];

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds,
        blockedLaneKeys: oversizedBlockedLaneKeys,
        scanLimit: 100,
      });

      expect(claimed?.id).toBe("free");
    });
  });

  it("claims a free row past a cap-plus-one blocked prefix without candidate ids", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // Same cap-plus-one shape as the candidate case, but the non-candidate
      // else branch selects pending rows directly. The keyset continuation must
      // page past the 10,001 blocked rows and reach the free row.
      const blockedCount = 10_001;
      for (let index = 0; index < blockedCount; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
      }
      await queue.enqueue(
        "free",
        { text: "free" },
        { laneKey: "free", receivedAt: blockedCount + 1 },
      );
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );
      for (let index = 0; index < blockedCount; index += 1) {
        oversizedBlockedLaneKeys[index] = `blocked-lane-${index}`;
      }

      const claimed = await queue.claimNext({
        ownerId: "worker",
        blockedLaneKeys: oversizedBlockedLaneKeys,
        scanLimit: 100,
      });

      expect(claimed?.id).toBe("free");
    });
  });

  it("bounds the degraded walk when no claimable row exists", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // More than two degraded pages of blocked rows with no free row behind
      // them. The claim must terminate (return null) without looping forever;
      // the keyset page cap bounds the work under the SQLite write lock.
      const blockedCount = 22_000;
      for (let index = 0; index < blockedCount; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
      }
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );
      for (let index = 0; index < blockedCount; index += 1) {
        oversizedBlockedLaneKeys[index] = `blocked-lane-${index}`;
      }

      const { spy, selectSqls } = observeSelectSql();
      let claimed: { id?: string } | null;
      try {
        claimed = await queue.claimNext({
          ownerId: "worker",
          blockedLaneKeys: oversizedBlockedLaneKeys,
          scanLimit: 100,
        });
      } finally {
        spy.mockRestore();
      }

      expect(claimed).toBeNull();
      // The non-candidate select is issued once per degraded page. With 22,000
      // blocked rows at 10,000 per page that is 3 pages, well under the page
      // cap; the assertion guards against an unbounded full-table scan.
      const nonCandidateSelects = selectSqls.filter((sql) => !sql.includes('"event_id" in'));
      expect(nonCandidateSelects.length).toBeLessThanOrEqual(105);
    });
  });

  it("preserves global ordering across the degraded keyset continuation", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // Two free rows behind a cap-plus-one blocked prefix. The first free row
      // in global (received_at, event_id) order sits at position 10,002; a
      // second free row at 10,003 has an earlier event_id lexicographically but
      // a later received_at, so it must NOT be claimed first. This confirms the
      // keyset continuation does not reorder or skip across pages.
      const blockedCount = 10_001;
      for (let index = 0; index < blockedCount; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
      }
      // free-a has the smaller received_at and is the global minimum free row.
      await queue.enqueue(
        "free-a",
        { text: "a" },
        { laneKey: "free-a", receivedAt: blockedCount + 1 },
      );
      // free-b has an event_id that sorts before "free-a" but a later
      // received_at, so global order still picks free-a first.
      await queue.enqueue(
        "free-b",
        { text: "b" },
        { laneKey: "free-b", receivedAt: blockedCount + 2 },
      );
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );
      for (let index = 0; index < blockedCount; index += 1) {
        oversizedBlockedLaneKeys[index] = `blocked-lane-${index}`;
      }
      const candidateIds = [
        ...Array.from({ length: blockedCount }, (_, index) => `blocked-${index}`),
        "free-a",
        "free-b",
      ];

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds,
        blockedLaneKeys: oversizedBlockedLaneKeys,
        scanLimit: 100,
      });

      expect(claimed?.id).toBe("free-a");
    });
  });

  it("caps the merged candidate traversal to the scan limit on the non-degraded path", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // Non-degraded path: a small blockedLaneKeys set keeps the SQL NOT IN
      // predicate, so blocked rows are pruned in SQL and the merged candidate
      // list is capped to scanLimit before the scan loop. More than scanLimit
      // free rows span two candidate chunks (chunk size is 1000); the claim
      // must pick the global-order minimum free row and never traverse past
      // the scanLimit window, matching main's single ordered LIMIT scanLimit.
      const freeCount = 150;
      for (let index = 0; index < freeCount; index += 1) {
        await queue.enqueue(
          `free-${index}`,
          { text: `free-${index}` },
          { laneKey: "free", receivedAt: index + 1 },
        );
      }
      // One blocked row on a different lane; SQL NOT IN prunes it, so it never
      // reaches the merged list and never consumes the scan budget.
      await queue.enqueue("blocked", { text: "blocked" }, { laneKey: "blocked", receivedAt: 0 });
      const candidateIds = [
        ...Array.from({ length: freeCount }, (_, index) => `free-${index}`),
        "blocked",
      ];

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds,
        blockedLaneKeys: ["blocked"],
        scanLimit: 100,
      });

      // The global-order minimum free row (received_at=1) is claimed; the cap
      // does not starve it. main's LIMIT scanLimit would select the same row.
      expect(claimed?.id).toBe("free-0");
    });
  });

  it("bounds JS-side materialization to the scan window across many candidate chunks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // Reproduces the ClawSweeper finding's scenario: a 33k candidate snapshot
      // with scanLimit 100. Chunk size 1000 yields 33 chunks; each chunk's SQL
      // LIMIT 100 returns at most 100 rows, so SQL read stays <= 3300, but the
      // incremental merge window is capped to scanLimit=100 by mergeTopKRowWindow
      // (the cap parameter statically bounds JS-side retention), instead of
      // materializing all 3300 rows and sorting them under the write lock.
      // Non-degraded path (no blockedLaneKeys), so SQL prunes nothing here.
      const freeCount = 33_000;
      for (let index = 0; index < freeCount; index += 1) {
        await queue.enqueue(
          `free-${index}`,
          { text: `free-${index}` },
          { laneKey: "free", receivedAt: index + 1 },
        );
      }
      const candidateIds = Array.from({ length: freeCount }, (_, index) => `free-${index}`);

      // Spy: accumulate rows returned by candidate-branch selects (= SQL read)
      // and count those selects, to assert total work stays bounded.
      const originalExecute = kyselySync.executeSqliteQuerySync;
      let totalRowsRead = 0;
      let candidateSelectCount = 0;
      const wrappedExecute = (
        db: Parameters<typeof originalExecute>[0],
        query: Parameters<typeof originalExecute>[1],
      ) => {
        const result = originalExecute(db, query);
        if (typeof query.compile === "function") {
          const sql = query.compile().sql;
          // Candidate-branch select: has the event_id IN membership predicate.
          // The else branch lacks '"event_id" in' (its order by mentions event_id
          // but never as an IN member), so this isolates the candidate path.
          if (
            sql.includes("channel_ingress_events") &&
            sql.includes('"event_id" in') &&
            sql.includes("limit")
          ) {
            candidateSelectCount += 1;
            totalRowsRead += result.rows.length;
          }
        }
        return result;
      };
      const spy = vi.spyOn(kyselySync, "executeSqliteQuerySync").mockImplementation(wrappedExecute);

      try {
        const claimed = await queue.claimNext({
          ownerId: "worker",
          candidateIds,
          scanLimit: 100,
        });

        // The global-order minimum free row (received_at=1 -> free-0) is
        // claimed, proving the incremental merge neither drops nor reorders the
        // global top-scanLimit (each chunk's top-scanLimit contains the global
        // top-scanLimit within that chunk).
        expect(claimed?.id).toBe("free-0");
        // One SQL per chunk, one pass (no corrupt re-run in this scenario): 33
        // selects for 33 chunks. No re-scan of the snapshot per claim.
        expect(candidateSelectCount).toBe(33);
        // SQL read is bounded at chunkCount * scanLimit = 3300. Read cannot drop
        // below this under chunked IN membership (SQLite must scan each chunk's
        // candidates to rank the top-scanLimit), but JS-side materialization is
        // bounded to scanLimit=100 by the merge window cap.
        expect(totalRowsRead).toBeLessThanOrEqual(33 * 100);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("bounds degraded candidate reads across chunks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // 22,000 blocked rows (each on its own stored lane) followed by one free
      // row, with 30,000 blockedLaneKeys and no deriveLaneKey: the SQL NOT IN
      // predicate is dropped, so the claim takes the degraded candidate path.
      // Pre-fix, every degraded keyset page re-selected every candidate chunk
      // (per-chunk LIMIT 10,000 > chunk size 1,000) and re-read the discarded
      // suffix, so this shape issued ~3 pages x 23 chunks and read ~36,000 rows
      // under the write lock. The stream merge must read each row at most once.
      const blockedCount = 22_000;
      for (let index = 0; index < blockedCount; index += 1) {
        await queue.enqueue(
          `blocked-${index}`,
          { text: `blocked-${index}` },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
      }
      await queue.enqueue(
        "free",
        { text: "free" },
        { laneKey: "free", receivedAt: blockedCount + 1 },
      );
      const candidateIds = [
        ...Array.from({ length: blockedCount }, (_, index) => `blocked-${index}`),
        "free",
      ];
      const oversizedBlockedLaneKeys = Array.from(
        { length: 30_000 },
        (_, index) => `stored-lane-${index}`,
      );
      for (let index = 0; index < blockedCount; index += 1) {
        oversizedBlockedLaneKeys[index] = `blocked-lane-${index}`;
      }

      // Spy: count candidate-branch selects (event_id IN membership) and the
      // rows those selects return.
      const originalExecute = kyselySync.executeSqliteQuerySync;
      let candidateSelectCount = 0;
      let candidateRowsRead = 0;
      const wrappedExecute = (
        db: Parameters<typeof originalExecute>[0],
        query: Parameters<typeof originalExecute>[1],
      ) => {
        const result = originalExecute(db, query);
        if (typeof query.compile === "function") {
          const sql = query.compile().sql;
          if (
            sql.includes("channel_ingress_events") &&
            sql.includes('"event_id" in') &&
            sql.includes("limit")
          ) {
            candidateSelectCount += 1;
            candidateRowsRead += result.rows.length;
          }
        }
        return result;
      };
      const spy = vi.spyOn(kyselySync, "executeSqliteQuerySync").mockImplementation(wrappedExecute);

      let claimed: { id?: string } | null;
      try {
        claimed = await queue.claimNext({
          ownerId: "worker",
          candidateIds,
          blockedLaneKeys: oversizedBlockedLaneKeys,
          scanLimit: 100,
        });
      } finally {
        spy.mockRestore();
      }

      expect(claimed?.id).toBe("free");
      // 23 chunks: one claimed-candidate pre-scan select per chunk plus one
      // degraded pending select per chunk = ~46 selects, with every candidate
      // row read once (~22,001 rows). Pre-fix this was ~92 selects / ~36,003
      // rows (3 keyset pages re-selecting all chunks and re-reading the suffix).
      expect(candidateSelectCount).toBeLessThanOrEqual(2 * 23 + 20);
      expect(candidateRowsRead).toBeLessThanOrEqual(blockedCount + 1 + 1_000);
    });
  });
});
