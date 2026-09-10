import { describe, expect, it, vi } from "vitest";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import { persistQueuedCronRunReservations } from "./run-admission.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";

// persistQueuedCronRunReservations builds the run-receipt claim via
// prepareServiceCronRunReceiptClaim, which throws on an ownerless job. That
// throw escapes the batch and aborts the whole timer tick ("cron: timer tick
// failed"), so one job without a resolvable owner stalls every sibling in the
// same batch. Filter ownerless candidates at the reservation boundary with the
// canonical skipped result, mirroring admission's skipCronJobsWithoutOwners.
describe("persistQueuedCronRunReservations ownerless skip", () => {
  it("skips an ownerless job instead of throwing", async () => {
    const state = createCronServiceState({
      storePath: "/tmp/cron-reservation-ownerless-skip.json",
      cronEnabled: true,
      // No static default and a dynamic resolver returning undefined mirrors
      // agents.defaults.systemAgent.agentId being unset.
      resolveDefaultAgentId: () => undefined,
      log: createNoopLogger(),
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" as const }),
    });
    await ensureLoaded(state, { forceReload: true });

    const now = Date.now();
    const ownerless: CronJob = makeCronJob({
      id: "ownerless",
      payload: { kind: "agentTurn", message: "run" },
      state: { nextRunAtMs: now },
    });
    await saveCronStore(state.deps.storePath, { version: 1, jobs: [ownerless] });
    await ensureLoaded(state, { forceReload: true });

    // Before the fix this threw "Agent-less cron job has no resolvable owner",
    // escaping the batch and aborting the whole timer tick.
    const reserved = await persistQueuedCronRunReservations({
      state,
      candidates: [ownerless],
      reservedAtMs: now,
    });

    // The ownerless job is filtered, not reserved.
    expect(reserved).toEqual([]);
    // It records the canonical skipped/failed owner result.
    const persistedOwnerless = (await loadCronStore(state.deps.storePath)).jobs.find(
      (job) => job.id === "ownerless",
    );
    expect(persistedOwnerless?.state).toMatchObject({
      lastRunStatus: "skipped",
      lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    });
  });
});
