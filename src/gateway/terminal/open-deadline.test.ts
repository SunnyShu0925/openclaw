import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_OPEN_DEADLINE_MS,
  TerminalOpenDeadlineError,
  createTerminalOpenDeadline,
  waitForTerminalOpenDeadline,
} from "./open-deadline.js";

describe("terminal open deadline on the monotonic clock", () => {
  it("expires and aborts when monotonic time reaches the deadline despite a wall-clock rewind", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      // Seed the deadline. Both Date.now() and performance.now() are 0, so
      // expiresAtMs = 30000 under both the bug and the fix.
      const deadline = createTerminalOpenDeadline();

      // Rewind the wall clock by 90s. Under vitest fake timers,
      // setSystemTime moves Date.now() but leaves performance.now() untouched.
      vi.setSystemTime(-90_000);

      // The open callback never resolves on its own (simulates a catalog
      // lookup that is still in flight). The deadline's setTimeout must fire
      // and expire the open.
      const never = new Promise<string>(() => {});

      const promise = waitForTerminalOpenDeadline(() => never, deadline);

      // Suppress the unhandled rejection from the abandoned `never` promise
      // chain so it does not surface as a test error.
      promise.catch(() => {});

      // Advance monotonic time to the deadline. performance.now() goes from
      // 0 to 30000, matching expiresAtMs.
      //
      // Under the fix (performance.now seed): the setTimeout delay is
      // 30000 - 0 = 30000, so advancing 30000 fires it → timeout.
      //
      // Under the bug (Date.now seed): the setTimeout delay is
      // 30000 - (-90000) = 120000, so advancing 30000 does not fire it
      // and the open never expires → the assertion below would fail.
      await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);

      await expect(promise).rejects.toThrow(TerminalOpenDeadlineError);
      expect(deadline.controller.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
