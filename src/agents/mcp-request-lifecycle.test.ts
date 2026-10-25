import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createMcpRequestLifecycle } from "./mcp-request-lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createMcpRequestLifecycle request timeout", () => {
  it("does not abort an in-flight request when the wall clock jumps forward during a human-input hold", async () => {
    vi.useFakeTimers();
    const lifecycle = createMcpRequestLifecycle(60_000);
    let aborted = false;
    const entered = createDeferred();
    const requestFinished = createDeferred<string>();
    const runPromise = lifecycle.run({ requestTimeoutMs: 30_000 }, async (signal, hold) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      // +120s exceeds the 30s deadline plus the 60s shareable allowance, so a
      // wall-clock budget collapses to zero while a monotonic one is unchanged.
      vi.setSystemTime(Date.now() + 120_000);
      hold();
      entered.resolve();
      return requestFinished.promise;
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(false);
    requestFinished.resolve("result");
    await expect(runPromise).resolves.toBe("result");
  });

  it("keeps the human-input allowance bounded when the wall clock jumps backward during a hold", async () => {
    vi.useFakeTimers();
    const lifecycle = createMcpRequestLifecycle(60_000);
    let aborted = false;
    const entered = createDeferred();
    const requestFinished = createDeferred<string>();
    const runPromise = lifecycle.run({ requestTimeoutMs: 30_000 }, async (signal, hold) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      const release = hold();
      // A backward step must not make the elapsed hold negative: doing so
      // refunds allowance the request never had and shifts the deadline back,
      // keeping the request alive far past the budget it was granted.
      vi.setSystemTime(Date.now() - 120_000);
      release();
      hold();
      entered.resolve();
      return requestFinished.promise;
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(aborted).toBe(true);
    requestFinished.resolve("result");
    await runPromise;
  });

  it("still aborts the request when its budget elapses without a clock step", async () => {
    vi.useFakeTimers();
    const lifecycle = createMcpRequestLifecycle(60_000);
    let aborted = false;
    const entered = createDeferred();
    const requestFinished = createDeferred<string>();
    const runPromise = lifecycle.run({ requestTimeoutMs: 30_000 }, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      entered.resolve();
      return requestFinished.promise;
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(aborted).toBe(true);
    requestFinished.resolve("result");
    await runPromise;
  });
});
