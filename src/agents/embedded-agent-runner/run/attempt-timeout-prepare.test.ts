// Coverage for attempt timeout ownership and cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";

function createTimeoutHarness(options?: {
  activeCompaction?: boolean;
  pendingCompaction?: boolean;
  timeoutMs?: number;
}) {
  const state = {
    activeCompaction: options?.activeCompaction ?? false,
    pendingCompaction: options?.pendingCompaction ?? false,
    streaming: false,
  };
  const abortController = new AbortController();
  const abortRun = vi.fn();
  const markExternalAbort = vi.fn();
  const markTimedOutDuringCompaction = vi.fn();
  const markTimedOutByRunBudget = vi.fn();
  const onAttemptTimeoutArmed = vi.fn();
  const timeout = prepareEmbeddedAttemptTimeout({
    attempt: {
      runId: "run-1",
      sessionId: "session-1",
      timeoutMs: options?.timeoutMs ?? 100,
      abortSignal: abortController.signal,
      onAttemptTimeoutArmed,
    },
    activeSession: {
      get isCompacting() {
        return state.activeCompaction;
      },
      get isStreaming() {
        return state.streaming;
      },
    },
    compactionState: {
      isCompacting: () => state.pendingCompaction,
    },
    compactionTimeoutMs: 50,
    isProbeSession: true,
    abortRun,
    markExternalAbort,
    markTimedOutDuringCompaction,
    markTimedOutByRunBudget,
  });
  return {
    abortController,
    abortRun,
    markExternalAbort,
    markTimedOutDuringCompaction,
    markTimedOutByRunBudget,
    onAttemptTimeoutArmed,
    state,
    timeout,
  };
}

describe("prepareEmbeddedAttemptTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms and fires the run budget timeout", async () => {
    const harness = createTimeoutHarness();

    expect(harness.onAttemptTimeoutArmed).toHaveBeenCalledOnce();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.markTimedOutByRunBudget).toHaveBeenCalledOnce();
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("grants one compaction grace window before aborting", async () => {
    const harness = createTimeoutHarness({ pendingCompaction: true });

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(150);

    harness.state.pendingCompaction = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("classifies an external timeout during compaction", () => {
    const harness = createTimeoutHarness({ activeCompaction: true });
    const reason = new Error("request timed out");
    reason.name = "TimeoutError";

    harness.abortController.abort(reason);

    expect(harness.markExternalAbort).toHaveBeenCalledOnce();
    expect(harness.markTimedOutDuringCompaction).toHaveBeenCalledOnce();
    expect(harness.abortRun).toHaveBeenCalledWith(true, reason);
    harness.timeout.clearTimers();
  });

  it("noteActivity resets the deadline forward on activity", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 200 });

    // Deadline starts at now + 200
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(200);

    // After 100ms of activity, noteActivity slides the deadline to now + 200
    await vi.advanceTimersByTimeAsync(100);
    harness.timeout.noteActivity();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(300);

    // The old timer (set at t=0 for t=200) was cleared — it should not fire
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.abortRun).not.toHaveBeenCalled();

    // The new timer fires at t=300
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("noteActivity does not cap on extension count — only absolute deadline bounds", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 100 });

    // Many sequential noteActivity calls all extend the deadline
    // (no extension-count cutoff — only the 120s absolute cap matters)
    for (let i = 0; i < 50; i++) {
      const deadlineBefore = harness.timeout.getRunAbortDeadlineAtMs();
      await vi.advanceTimersByTimeAsync(1);
      harness.timeout.noteActivity();
      expect(harness.timeout.getRunAbortDeadlineAtMs()).toBeGreaterThan(deadlineBefore);
    }

    // The timer fires at the last-slid deadline, not prematurely
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("noteActivity clears the previous timer to prevent premature firing", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 100 });

    // At t=0: timer set for t=100
    // At t=50: noteActivity creates new timer for t=150
    await vi.advanceTimersByTimeAsync(50);
    harness.timeout.noteActivity();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(150);

    // The old timer (t=100) should have been cleared — advance past it
    await vi.advanceTimersByTimeAsync(55); // now at t=105
    expect(harness.abortRun).not.toHaveBeenCalled();

    // Only the new timer fires at t=150
    await vi.advanceTimersByTimeAsync(50); // now at t=155
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("noteActivity totalExtendedMs uses actual wall-clock elapsed time", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 1000 });

    // After 500ms of inactivity, noteActivity slides deadline to now + 1000
    await vi.advanceTimersByTimeAsync(500);
    harness.timeout.noteActivity();
    // deadline = 500 + 1000 = 1500
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(1500);

    // After 100ms, noteActivity slides deadline to now + 1000 from current time
    await vi.advanceTimersByTimeAsync(100);
    harness.timeout.noteActivity();
    // deadline = 600 + 1000 = 1600 (not 1100 — it slides from current wall clock)
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(1600);

    harness.timeout.clearTimers();
  });

  it("noteActivity clamps deadline to MAX_EXTENSION_TOTAL_MS from run start", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 30_000 }); // 30s sliding window

    // runStartMs = 0, MAX_EXTENSION_TOTAL_MS = 120_000
    // After 119s, a progress event would normally schedule deadline at 119 + 30 = 149s,
    // but the clamp should limit it to 120s (runStartMs + MAX_EXTENSION_TOTAL_MS).
    await vi.advanceTimersByTimeAsync(119_000);
    harness.timeout.noteActivity();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(120_000);

    // The timer fires at 120s (not 149s)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("noteActivity clamps deadline on the exact cap boundary", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 120_000 });

    // At t=119_990ms, noteActivity would schedule deadline at 119_990 + 5000 = 124_990,
    // clamped to 120_000. delayMs = max(1, 120_000 - 119_990) = 10.
    await vi.advanceTimersByTimeAsync(119_990);
    harness.timeout.noteActivity();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(120_000);

    // The old timer (at 120_000) was cleared — timer now fires in 10ms
    await vi.advanceTimersByTimeAsync(9);
    expect(harness.abortRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2); // crosses 120_000
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("noteActivity aborts immediately when past the absolute cap (fail-closed)", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 30_000 });

    // At t=120_000ms (past the 120s absolute cap):
    //   - The initial 30s timer already fired at t=30s, calling abortRun + markTimedOutByRunBudget
    //   - noteActivity at cap must also abort immediately (fail-closed, not a 1ms timer)
    await vi.advanceTimersByTimeAsync(120_000);

    // Initial timer already called this once; noteActivity calls it again
    const beforeCount = harness.abortRun.mock.calls.length;

    harness.timeout.noteActivity();
    expect(harness.markTimedOutByRunBudget).toHaveBeenCalled();
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    expect(harness.abortRun.mock.calls.length).toBe(beforeCount + 1);

    harness.timeout.clearTimers();
  });

  it("noteActivity fires cap abort exactly once — subsequent calls are no-ops", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 30_000 });

    await vi.advanceTimersByTimeAsync(120_000);
    const beforeCount = harness.abortRun.mock.calls.length;

    // First noteActivity past the cap fires abort once
    harness.timeout.noteActivity();
    expect(harness.abortRun.mock.calls.length).toBe(beforeCount + 1);

    // Subsequent noteActivity calls are no-ops — re-calling abortRun is not
    // idempotent and can trigger side-effects (onAttemptTimeout, session
    // lock release, run-abandoned markers).
    harness.timeout.noteActivity();
    expect(harness.abortRun.mock.calls.length).toBe(beforeCount + 1);

    harness.timeout.noteActivity();
    expect(harness.abortRun.mock.calls.length).toBe(beforeCount + 1);

    harness.timeout.clearTimers();
  });

  it("noteActivity does not clamp when below the total cap", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 1000 });

    // At t=10_000ms, 10_000 + 1000 = 11_000 < 120_000 → unclamped
    await vi.advanceTimersByTimeAsync(10_000);
    harness.timeout.noteActivity();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(11_000);

    harness.timeout.clearTimers();
  });

  it("noteActivity respects timeoutMs above MAX_EXTENSION_TOTAL_MS", async () => {
    // Configure timeoutMs = 180s, above the 120s hard floor. The effective
    // max run time should be max(180000, 120000) = 180000, NOT 120000.
    const harness = createTimeoutHarness({ timeoutMs: 180_000 });
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(180_000);

    // After 100s of wall clock, noteActivity should extend to now + 180s = 280s,
    // clamped by effectiveMaxRunMs = 180s from runStart => cap = 180s.
    // 100s + 180s = 280s > 180s cap → clamped to 180s.
    await vi.advanceTimersByTimeAsync(100_000);
    harness.timeout.noteActivity();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(180_000);

    // Verify the timer actually fires at 180s, not earlier at 120s.
    await vi.advanceTimersByTimeAsync(79_999);
    expect(harness.abortRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2); /* crosses 180_000 */
    expect(harness.abortRun).toHaveBeenCalledWith(true);

    harness.timeout.clearTimers();
  });

  it("timer-triggered cap abort sets hasAbortedAtCap so noteActivity is no-op", async () => {
    const harness = createTimeoutHarness({ timeoutMs: 120_000 });

    // The initial timer is set at t=0 for delay=120000ms.
    // At t=120000ms, the timer fires AT the absolute cap.
    await vi.advanceTimersByTimeAsync(120_000);

    // The timer callback fires abortRun once and sets hasAbortedAtCap
    expect(harness.abortRun).toHaveBeenCalledTimes(1);

    // Subsequent noteActivity calls must be no-ops — the timer-triggered
    // abort already marked the cap as terminal.
    const afterTimerCount = harness.abortRun.mock.calls.length;

    harness.timeout.noteActivity();
    expect(harness.abortRun.mock.calls.length).toBe(afterTimerCount);

    harness.timeout.noteActivity();
    expect(harness.abortRun.mock.calls.length).toBe(afterTimerCount);

    harness.timeout.clearTimers();
  });

  it("cleans up both the timer and external abort listener", async () => {
    const harness = createTimeoutHarness();

    harness.timeout.clearTimers();
    harness.timeout.removeAbortSignalListener();
    harness.abortController.abort(new Error("late abort"));
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.markExternalAbort).not.toHaveBeenCalled();
    expect(harness.markTimedOutByRunBudget).not.toHaveBeenCalled();
    expect(harness.abortRun).not.toHaveBeenCalled();
  });
});
