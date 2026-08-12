// Deterministic proof driver for #119313: a mid-turn recovery route that
// trimmed nothing (truncatedCount === 0) changes no session state, so it is a
// fixed-point retry that must spend the retry budget like any other recovery.
// The run loop's retry-limit exit must fire at maxAttempts instead of looping
// forever while refunding the only enforced counter.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("run retry budget no-op mid-turn wall (proof #119313)", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
  });

  it("stops a fixed-point no-op mid-turn loop at the 32-dispatch cap with retry_limit", async () => {
    // Every attempt returns the mid-turn precheck no-op outcome from
    // attempt-prompt-preflight.ts: route=truncate_tool_results_only,
    // source=mid-turn, handled=true, truncatedCount=0, plus one non-erroring
    // tool call. Under the corrected contract this is a recovery retry (nothing
    // was trimmed), so it spends budget and the cap trips at maxAttempts.
    mockedRunEmbeddedAttempt.mockImplementation(async () =>
      makeAttemptResult({
        preflightRecovery: {
          route: "truncate_tool_results_only",
          source: "mid-turn",
          handled: true as const,
          truncatedCount: 0,
        },
        toolMetas: [{ toolName: "read", meta: "step", isError: false }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-proof-119313-noop-wall",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.error?.message).toContain("after 32 attempts");
    expect(result.meta.error?.message).toContain("max=32");
  });

  it("never dispatches a 33rd attempt even when a later attempt would complete", async () => {
    let calls = 0;
    mockedRunEmbeddedAttempt.mockImplementation(async () => {
      calls += 1;
      if (calls >= 33) {
        return makeAttemptResult();
      }
      return makeAttemptResult({
        preflightRecovery: {
          route: "truncate_tool_results_only",
          source: "mid-turn",
          handled: true as const,
          truncatedCount: 0,
        },
        toolMetas: [{ toolName: "read", meta: "step", isError: false }],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-proof-119313-no-33rd",
    });

    // The run stops at the budget wall: a would-be completing attempt that
    // would have been the 33rd dispatch is never reached.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(result.meta.error?.kind).toBe("retry_limit");
  });

  it("does not bound a run whose mid-turn retries actually trim content", async () => {
    // A real truncation (truncatedCount > 0) is genuine progress: it refunds
    // attemptsCounted, so a long run of real truncations is never bounded by
    // the cap and completes when the model stops returning overflow recoveries.
    let calls = 0;
    mockedRunEmbeddedAttempt.mockImplementation(async () => {
      calls += 1;
      if (calls >= 40) {
        return makeAttemptResult();
      }
      return makeAttemptResult({
        preflightRecovery: {
          route: "truncate_tool_results_only",
          source: "mid-turn",
          handled: true as const,
          truncatedCount: 2,
        },
        toolMetas: [{ toolName: "read", meta: "step", isError: false }],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-proof-119313-real-progress",
    });

    // 40 dispatched attempts — past the 32 cap — and the run completes instead
    // of returning retry_limit, proving real progress is not bounded.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(40);
    expect(result.meta.error?.kind).not.toBe("retry_limit");
  });
});
