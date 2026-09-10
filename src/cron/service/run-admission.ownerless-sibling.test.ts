import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { persistQueuedCronRunReservations } from "./run-admission.js";
import { list } from "./ops-read.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-reservation-ownerless-" });

// Mixed-batch companion to run-admission.ownerless-skip.test.ts: when an
// ownerless job and an owned job are reserved together, the ownerless one must
// be skipped (not throw and abort the batch) while the owned sibling is still
// reserved. Before the fix the ownerless throw escaped the batch and the owned
// sibling never got a reservation.
it("keeps an owned sibling reserved when an ownerless job is in the same batch", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-09-06T20:24:00.000Z");
  const ownerless = createDueIsolatedJob({ id: "ownerless", nowMs: now, nextRunAtMs: now });
  const owned = { ...createDueIsolatedJob({ id: "owned", nowMs: now, nextRunAtMs: now }), agentId: "ops" };
  await saveCronStore(store.storePath, { version: 1, jobs: [ownerless, owned] });

  const state = createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => now,
    // No configured default agent: ownerless has no resolvable owner.
    resolveDefaultAgentId: () => undefined,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await list(state);

  const reserved = await persistQueuedCronRunReservations({
    state,
    candidates: [ownerless, owned],
    reservedAtMs: now,
  });

  // The owned sibling is reserved; the ownerless job is filtered.
  expect(reserved.map(({ job }) => job.id)).toEqual(["owned"]);
  const persisted = (await loadCronStore(store.storePath)).jobs;
  expect(persisted.find((job) => job.id === "ownerless")?.state).toMatchObject({
    lastRunStatus: "skipped",
  });
  expect(persisted.find((job) => job.id === "owned")?.state).toMatchObject({
    queuedAtMs: now,
  });
});
