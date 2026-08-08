// Regression coverage for bounded full-drain candidate work: the drain pass
// must not re-read every candidate chunk on every claim of a 32-start pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kyselySync from "../../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain claim bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("bounds full-drain candidate membership queries across a 32-start pass", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      // 33,000 pending rows on distinct lanes reproduce the ClawSweeper P1
      // scenario: pre-fix, every claim handed the full snapshot to claimNext,
      // which re-read all 33 candidate chunks twice (claimed pre-scan + pending
      // select), so one 32-start pass issued ~2,112 selects and read ~105,600
      // rows. The bounded window must keep the pass at one candidate chunk per
      // claim (window = scanLimit, chunk size 1000) with no snapshot re-scan.
      const count = 33_000;
      for (let index = 0; index < count; index += 1) {
        await queue.enqueue(
          `free-${index}`,
          { text: `free-${index}` },
          { laneKey: `lane-${index}`, receivedAt: index + 1 },
        );
      }
      const dispatched: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        startLimit: 32,
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatched.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      // Count every channel_ingress_events select carrying an event_id IN
      // membership predicate (claimed-candidate pre-scan + pending candidate
      // select) and the rows those membership selects return.
      const originalExecute = kyselySync.executeSqliteQuerySync;
      let membershipSelectCount = 0;
      let membershipRowsRead = 0;
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
            sql.includes("select")
          ) {
            membershipSelectCount += 1;
            membershipRowsRead += result.rows.length;
          }
        }
        return result;
      };
      const spy = vi.spyOn(kyselySync, "executeSqliteQuerySync").mockImplementation(wrappedExecute);

      let started: number;
      try {
        ({ started } = await drain.drainOnce());
        await drain.waitForIdle();
      } finally {
        spy.mockRestore();
      }

      // Global-order claim results and lane behavior are unchanged.
      expect(started).toBe(32);
      expect(dispatched).toEqual(Array.from({ length: 32 }, (_, index) => `free-${index}`));
      // One pre-scan select + one pending select per claim: 64 membership
      // selects and <= 3,200 membership rows for a 32-start pass (the pre-fix
      // drain issued 2,112 selects and read 105,600 rows for the same pass).
      expect(membershipSelectCount).toBeLessThanOrEqual(2 * 32 + 8);
      expect(membershipRowsRead).toBeLessThanOrEqual(2 * 32 * 100 + 1_000);
      drain.dispose();
    });
  });

  it("claims past a blocked prefix within one drain pass via the bounded window", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      // 100 retry-delayed rows (each on its own lane) fill the initial scanLimit
      // window; 100 free rows sit behind them. The drain-level bounded window
      // must grow past the blocked prefix and keep claiming instead of returning
      // null and starving the free rows (the round-2 starvation shape, now at
      // the drain pass level).
      const blockedCount = 100;
      for (let index = 0; index < blockedCount; index += 1) {
        const id = `blocked-${index}`;
        await queue.enqueue(
          id,
          { text: id },
          { laneKey: `blocked-lane-${index}`, receivedAt: index + 1 },
        );
        const claim = await queue.claim(id, { ownerId: "test-worker" });
        if (!claim) {
          throw new Error(`expected a claim for ${id}`);
        }
        await queue.release(claim, { recordAttempt: true, lastError: "retry" });
      }
      for (let index = 0; index < blockedCount; index += 1) {
        await queue.enqueue(
          `free-${index}`,
          { text: `free-${index}` },
          { laneKey: `free-lane-${index}`, receivedAt: blockedCount + index + 1 },
        );
      }
      const dispatched: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        scanLimit: 100,
        startLimit: 8,
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatched.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      const { started } = await drain.drainOnce();
      await drain.waitForIdle();

      expect(started).toBe(8);
      expect(dispatched).toEqual(Array.from({ length: 8 }, (_, index) => `free-${index}`));
      drain.dispose();
    });
  });
});
