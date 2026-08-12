import { describe, expect, it } from "vitest";
import {
  beginRunAttempt,
  createRunRetryBudget,
  isRunRetryBudgetExhausted,
  recordRunRetry,
  resolveRunRetryKind,
} from "./retry-budget.js";

describe("run retry budget", () => {
  it("allows more than 32 progressing continuations that actually trimmed content", () => {
    const budget = createRunRetryBudget(32);

    for (let step = 0; step < 33; step += 1) {
      beginRunAttempt(budget);
      recordRunRetry(
        budget,
        resolveRunRetryKind({
          preflightRecovery: {
            route: "truncate_tool_results_only",
            truncatedCount: 1,
          },
          retryingFromTranscript: true,
          toolMetas: [{ toolName: "read", meta: `step=${step}`, isError: false }],
        }),
      );
    }

    // A real truncation (truncatedCount > 0) is genuine progress: it refunds
    // attemptsCounted and is never bounded by the cap, so a long run of real
    // tool-loop progress can exceed maxAttempts.
    expect(budget).toEqual({ attemptsDispatched: 33, attemptsCounted: 0, maxAttempts: 32 });
    expect(isRunRetryBudgetExhausted(budget)).toBe(false);
  });

  it("bounds a fixed-point run of no-op mid-turn continuations at the retry cap", () => {
    const budget = createRunRetryBudget(32);

    for (let step = 0; step < 32; step += 1) {
      beginRunAttempt(budget);
      recordRunRetry(
        budget,
        resolveRunRetryKind({
          preflightRecovery: {
            route: "truncate_tool_results_only",
            truncatedCount: 0,
          },
          retryingFromTranscript: true,
          toolMetas: [{ toolName: "read", meta: `step=${step}`, isError: false }],
        }),
      );
      // A no-op recovery (truncatedCount === 0) changed no session state, so it
      // spends budget like any other recovery retry and the cap trips at 32.
      expect(isRunRetryBudgetExhausted(budget)).toBe(step >= 31);
    }

    expect(budget.attemptsDispatched).toBe(32);
    expect(budget.attemptsCounted).toBe(32);
    expect(isRunRetryBudgetExhausted(budget)).toBe(true);
  });

  it("still stops 32 retries that make no progress", () => {
    const budget = createRunRetryBudget(32);

    for (let retry = 0; retry < 32; retry += 1) {
      beginRunAttempt(budget);
      recordRunRetry(budget, "recovery");
    }

    expect(isRunRetryBudgetExhausted(budget)).toBe(true);
  });

  it("does not erase retries used before a progress continuation", () => {
    const budget = createRunRetryBudget(32);
    for (let retry = 0; retry < 31; retry += 1) {
      beginRunAttempt(budget);
      recordRunRetry(budget, "recovery");
    }

    beginRunAttempt(budget);
    recordRunRetry(budget, "progress_continuation");
    expect(budget.attemptsCounted).toBe(31);

    beginRunAttempt(budget);
    recordRunRetry(budget, "recovery");
    expect(isRunRetryBudgetExhausted(budget)).toBe(true);
  });
});
