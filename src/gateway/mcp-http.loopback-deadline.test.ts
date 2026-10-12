import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  waitForMcpLoopbackToolCallCaptureIdle,
} from "./mcp-http.loopback-runtime.js";

describe("waitForMcpLoopbackToolCallCaptureIdle monotonic deadline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The deadline owner seeds and reads its remaining budget from the same
  // clock. With a wall-clock seed, a backward jump after seeding enlarges the
  // computed remaining budget and stalls the capture wait; with a monotonic
  // seed the deadline expires on elapsed time regardless of wall-clock moves.
  // Fake timers control both clocks so the budget assertion does not depend on
  // a real-timer threshold (AGENTS.md forbids new real-timer tests).
  it("expires on the monotonic clock after a backward wall-clock jump", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout"] });

    const captureKey = "monotonic-deadline-backward";
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: vi.fn(),
    });
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey,
      toolName: "message",
      args: { action: "send", target: "stalled" },
    });
    if (!captureHandle) {
      throw new Error("Expected MCP capture admission");
    }

    // Let the deadline seed normally, then yank the wall-clock backward so a
    // Date.now()-anchored budget would read ~60s of remaining instead of 120ms.
    const seedTime = Date.now();
    let deadlineSeeded = false;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      if (!deadlineSeeded) {
        deadlineSeeded = true;
        return seedTime;
      }
      return seedTime - 60_000;
    });

    try {
      // Start the idle wait without awaiting; the activity wait now holds.
      const idlePromise = waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
        timeoutMs: 120,
        admissionGraceMs: 0,
      });

      // Advance the monotonic timer past the original 120ms budget, plus
      // 1ms for the guard below. A Date.now()-anchored deadline still sees
      // ~60s remaining and the wait has not settled; a performance.now() anchor
      // expires and resolves false.
      await vi.advanceTimersByTimeAsync(122);

      // A baseline anchored on Date.now() keeps ~60s of budget and the
      // wait is still pending; the monotonic anchor has resolved false.
      const pending = Symbol("pending");
      const settled = Promise.race([
        idlePromise,
        new Promise<typeof pending>((resolve) => {
          setTimeout(() => {
            resolve(pending);
          }, 1);
        }),
      ]);
      // Flush any pending fake timers so either the idle wait resolves or
      // the guard fires.
      await vi.advanceTimersByTimeAsync(1);
      const result = await settled;
      expect(result).toBe(false);
    } finally {
      dateNow.mockRestore();
      vi.useRealTimers();
      markMcpLoopbackToolCallFinished(captureHandle);
      clearMcpLoopbackToolCallCapture(captureKey);
    }
  });
});
