import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

// Mock only the router so the deadline arithmetic inside
// dispatchGatewayRequestInProcessRaw is the sole code under test. The timeout
// path (resolveDispatchDeadline, waitForDispatch, raceWithTimeout, setTimeout)
// is production code with real fake-timer-driven setTimeout.
const handleGatewayRequest = vi.hoisted(() => vi.fn());
vi.mock("./server-methods.js", () => ({ handleGatewayRequest }));

describe("dispatchGatewayRequestInProcessRaw deadline clock", () => {
  let perfSpy: ReturnType<typeof vi.spyOn>;
  let dateSpy: ReturnType<typeof vi.spyOn>;
  let monotonicMs: number;
  let wallMs: number;
  const heldGates: ReturnType<typeof createDeferredCore>[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    monotonicMs = 0;
    wallMs = 1_000_000;
    perfSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    dateSpy = vi.spyOn(Date, "now").mockImplementation(() => wallMs);
  });

  afterEach(() => {
    for (const gate of heldGates.splice(0)) {
      gate.resolve();
    }
    perfSpy.mockRestore();
    dateSpy.mockRestore();
    vi.useRealTimers();
    handleGatewayRequest.mockReset();
  });

  it("fires the timeout on the monotonic clock despite a wall-clock rollback between seed and wait", async () => {
    const entered = createDeferredCore();
    const handlerDone = createDeferredCore();
    heldGates.push(handlerDone);
    const execute = async (options: GatewayRequestOptions) => {
      entered.resolve();
      wallMs -= 10_000;
      await handlerDone.promise;
      options.respond(true, { status: "ok" });
    };
    handleGatewayRequest.mockImplementation(execute);

    let settled: "resolved" | "rejected" | undefined;
    const dispatchPromise = dispatchGatewayRequestInProcessRaw(
      "test.method",
      {},
      {
        client: null,
        context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
        timeoutMs: 1_000,
      },
    );
    void dispatchPromise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );

    await entered.promise;
    await vi.advanceTimersByTimeAsync(0);

    // Advance 1_000ms of monotonic time. A wall-clock deadline would have
    // ~11_000ms of inflated budget; a monotonic deadline fires now.
    monotonicMs += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe("rejected");
    handlerDone.resolve();
  });

  it("does not shrink the timeout on a wall-clock forward jump between seed and wait", async () => {
    const entered = createDeferredCore();
    const handlerDone = createDeferredCore();
    heldGates.push(handlerDone);
    const execute = async (options: GatewayRequestOptions) => {
      entered.resolve();
      wallMs += 10_000;
      await handlerDone.promise;
      options.respond(true, { status: "ok" });
    };
    handleGatewayRequest.mockImplementation(execute);

    let timedOut = false;
    const dispatchPromise = dispatchGatewayRequestInProcessRaw(
      "test.method",
      {},
      {
        client: null,
        context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
        timeoutMs: 2_000,
      },
    );
    void dispatchPromise.catch(() => {
      timedOut = true;
    });

    await entered.promise;
    await vi.advanceTimersByTimeAsync(0);

    // Advance 1_000ms of monotonic time — well within the 2_000ms budget.
    monotonicMs += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(timedOut).toBe(false);

    // Advance the remaining 1_000ms to hit the real monotonic deadline.
    monotonicMs += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(timedOut).toBe(true);
    handlerDone.resolve();
  });
});
