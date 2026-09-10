import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { clearCommandLane, getTotalQueueSize } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { list } from "./ops-read.js";
import { enqueueRun, run } from "./ops-run.js";
import { persistQueuedCronRunReservations } from "./run-admission.js";
import type { CronEvent } from "./state.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-reservation-ownerless-" });

// An ownerless job must be skipped (not throw and abort the batch) at the
// reservation boundary, preserving owned siblings and the manual-run completion
// contract (runId correlation, schedule preservation, no duplicate events).
describe("persistQueuedCronRunReservations ownerless handling", () => {
  it("skips an ownerless job instead of throwing", async () => {
    const state = createCronServiceState({
      storePath: "/tmp/cron-reservation-ownerless-skip.json",
      cronEnabled: true,
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

    const reserved = await persistQueuedCronRunReservations({
      state,
      candidates: [ownerless],
      reservedAtMs: now,
    });

    expect(reserved).toEqual([]);
    const persisted = (await loadCronStore(state.deps.storePath)).jobs.find(
      (job) => job.id === "ownerless",
    );
    expect(persisted?.state).toMatchObject({
      lastRunStatus: "skipped",
      lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    });
  });

  it("keeps an owned sibling reserved when an ownerless job is in the same batch", async () => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-09-06T20:24:00.000Z");
    const ownerless = createDueIsolatedJob({ id: "ownerless", nowMs: now, nextRunAtMs: now });
    const owned = {
      ...createDueIsolatedJob({ id: "owned", nowMs: now, nextRunAtMs: now }),
      agentId: "ops",
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [ownerless, owned] });

    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      resolveDefaultAgentId: () => undefined,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await list(state);

    const reserved = await persistQueuedCronRunReservations({
      state,
      candidates: [ownerless, owned],
      reservedAtMs: now,
    });

    expect(reserved.map(({ job }) => job.id)).toEqual(["owned"]);
    const persisted = (await loadCronStore(store.storePath)).jobs;
    expect(persisted.find((job) => job.id === "ownerless")?.state).toMatchObject({
      lastRunStatus: "skipped",
    });
    expect(persisted.find((job) => job.id === "owned")?.state).toMatchObject({
      queuedAtMs: now,
    });
  });

  it("preserves a future one-shot schedule when skipping with scheduleMode preserve", async () => {
    const state = createCronServiceState({
      storePath: "/tmp/cron-reservation-ownerless-preserve.json",
      cronEnabled: true,
      resolveDefaultAgentId: () => undefined,
      log: createNoopLogger(),
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" as const }),
    });
    await ensureLoaded(state, { forceReload: true });

    const futureRunAtMs = Date.now() + 3_600_000;
    const ownerless: CronJob = makeCronJob({
      id: "ownerless-oneshot",
      schedule: { kind: "at", at: new Date(futureRunAtMs).toISOString() },
      state: { nextRunAtMs: futureRunAtMs },
    });
    await saveCronStore(state.deps.storePath, { version: 1, jobs: [ownerless] });
    await ensureLoaded(state, { forceReload: true });

    const reserved = await persistQueuedCronRunReservations({
      state,
      candidates: [ownerless],
      reservedAtMs: Date.now(),
      scheduleMode: "preserve",
    });

    expect(reserved).toEqual([]);
    const persisted = (await loadCronStore(state.deps.storePath)).jobs.find(
      (job) => job.id === "ownerless-oneshot",
    );
    expect(persisted?.state).toMatchObject({
      lastRunStatus: "skipped",
      lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    });
    expect(persisted?.enabled).toBe(true);
    expect(persisted?.state.nextRunAtMs).toBe(futureRunAtMs);
  });

  it("carries the acknowledged runId in exactly one terminal event for manual runs", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);

    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-09-06T20:24:00.000Z");
    const ownerless = createDueIsolatedJob({ id: "ownerless", nowMs: now, nextRunAtMs: now });
    await saveCronStore(store.storePath, { version: 1, jobs: [ownerless] });

    const events: CronEvent[] = [];
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      resolveDefaultAgentId: () => undefined,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: (event) => {
        events.push(structuredClone(event));
      },
    });
    await list(state);

    const ack = await enqueueRun(state, ownerless.id, "force");
    expect(ack).toMatchObject({ ok: true, enqueued: true });
    const runId = (ack as { runId: string }).runId;

    await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });

    const finishedEvents = events.filter(
      (event) => event.action === "finished" && event.jobId === ownerless.id,
    );
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0]?.runId).toBe(runId);
    expect(finishedEvents[0]?.status).toBe("skipped");
    expect(finishedEvents[0]?.error).toBe(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);

    clearCommandLane(CommandLane.Cron);
  });
});

describe("direct run() ownerless disposition", () => {
  it("returns ownerless reason for direct run without a terminal tracker", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);

    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-09-06T20:24:00.000Z");
    const ownerless = createDueIsolatedJob({
      id: "ownerless-direct",
      nowMs: now,
      nextRunAtMs: now,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [ownerless] });

    const events: CronEvent[] = [];
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      resolveDefaultAgentId: () => undefined,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: (event) => {
        events.push(structuredClone(event));
      },
    });
    await list(state);

    // Direct run() call — no terminalTracker, no runId, no enqueueRun.
    const result = await run(state, ownerless.id, "force");

    expect(result).toMatchObject({ ok: true, ran: false, reason: "ownerless" });

    // The ownerless skip still emits exactly one terminal event.
    const finishedEvents = events.filter(
      (event) => event.action === "finished" && event.jobId === ownerless.id,
    );
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0]?.status).toBe("skipped");
    expect(finishedEvents[0]?.error).toBe(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);

    clearCommandLane(CommandLane.Cron);
  });
});
