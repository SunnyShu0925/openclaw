import { afterEach, describe, expect, it, vi } from "vitest";
import { installCodexComputerUse } from "./computer-use.js";
import { createClientHarness } from "./test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Computer Use request deadline", () => {
  it.each([0, -120_000, 120_000])("keeps its budget with wall-clock offset %i", async (offset) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_700_000_000_000);
    let reads = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => 1_700_000_000_000 + (reads++ === 0 ? 0 : offset),
    );
    const harness = createClientHarness();
    const timeouts: Array<number | undefined> = [];
    let requestSettled = false;
    let requestError: unknown;
    const originalRequest = harness.client.request.bind(harness.client);
    vi.spyOn(harness.client, "request").mockImplementation((method, params, options) => {
      timeouts.push(options?.timeoutMs);
      const pending = originalRequest(method, params, options);
      void pending.then(
        () => {
          requestSettled = true;
        },
        (error: unknown) => {
          requestSettled = true;
          requestError = error;
        },
      );
      return pending;
    });
    // A written config mutation can keep install retirement waiting for process exit.
    const operation = installCodexComputerUse({
      client: harness.client,
      pluginConfig: { computerUse: { autoInstall: true } },
      timeoutMs: 1_000,
    }).catch(() => undefined);
    try {
      const firstWrite = await harness.waitForWrite(0);
      expect(JSON.parse(firstWrite).method).toBe("experimentalFeature/enablement/set");
      expect(timeouts).toEqual([1_000]);
      await vi.advanceTimersByTimeAsync(999);
      expect(requestSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(requestSettled).toBe(true);
      expect(requestError).toBeInstanceOf(Error);
      expect(requestError).toHaveProperty("message", expect.stringContaining("timed out"));
    } finally {
      harness.client.close();
      harness.process.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await operation;
    }
  });
});

describe("Computer Use marketplace discovery deadline", () => {
  it("survives a 120-second wall-clock forward jump during discovery", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_700_000_000_000);
    let dateReads = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => 1_700_000_000_000 + (dateReads++ === 0 ? 0 : 120_000),
    );
    let pluginListCalls = 0;
    const pollDelays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: (...args: unknown[]) => void,
      delay?: number,
      ...rest: unknown[]
    ) => {
      if (typeof delay === "number" && delay > 100 && delay <= 2_000) {
        pollDelays.push(delay);
      }
      return realSetTimeout(() => cb(...rest), delay);
    }) as typeof setTimeout);
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.id === undefined || typeof message.method !== "string") {
          return;
        }
        switch (message.method) {
          case "experimentalFeature/enablement/set":
            send({ id: message.id, result: {} });
            break;
          case "experimentalFeature/list":
            send({
              id: message.id,
              result: { data: [{ name: "plugins", enabled: true }] },
            });
            break;
          case "plugin/list":
            pluginListCalls += 1;
            if (pluginListCalls === 1) {
              send({
                id: message.id,
                result: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
              });
            } else {
              send({
                id: message.id,
                result: {
                  marketplaces: [
                    {
                      name: "openai-curated",
                      path: "/curated",
                      plugins: [{ name: "computer-use", id: "computer-use" }],
                    },
                  ],
                  marketplaceLoadErrors: [],
                  featuredPluginIds: [],
                },
              });
            }
            break;
          default:
            send({ id: message.id, result: {} });
        }
      },
    });
    const operation = installCodexComputerUse({
      client: harness.client,
      pluginConfig: { computerUse: { autoInstall: true } },
      timeoutMs: 30_000,
    }).catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(2_100);
    } finally {
      harness.client.close();
      harness.process.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await operation;
    }
    expect(pluginListCalls).toBeGreaterThanOrEqual(2);
    expect(pollDelays.length).toBeGreaterThan(0);
    for (const delay of pollDelays) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
  });

  it.each([120_000, 0, -120_000] as const)(
    "bounds total wait with continuously empty inventory after wall-clock offset %i",
    async (offset) => {
      vi.useFakeTimers({
        toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
      });
      vi.setSystemTime(1_700_000_000_000);
      let reads = 0;
      vi.spyOn(Date, "now").mockImplementation(
        () => 1_700_000_000_000 + (reads++ === 0 ? 0 : offset),
      );
      let pluginListCalls = 0;
      const pollDelays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        cb: (...args: unknown[]) => void,
        delay?: number,
        ...rest: unknown[]
      ) => {
        if (typeof delay === "number" && delay > 0 && delay <= 2_000) {
          pollDelays.push(delay);
        }
        return realSetTimeout(() => cb(...rest), delay);
      }) as typeof setTimeout);
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const message = JSON.parse(line) as { id?: unknown; method?: string };
          if (message.id === undefined || typeof message.method !== "string") {
            return;
          }
          switch (message.method) {
            case "experimentalFeature/enablement/set":
              send({ id: message.id, result: {} });
              break;
            case "experimentalFeature/list":
              send({
                id: message.id,
                result: { data: [{ name: "plugins", enabled: true }] },
              });
              break;
            case "plugin/list":
              pluginListCalls += 1;
              send({
                id: message.id,
                result: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
              });
              break;
            default:
              send({ id: message.id, result: {} });
          }
        },
      });
      let operationSettled = false;
      const operation = installCodexComputerUse({
        client: harness.client,
        pluginConfig: {
          computerUse: { autoInstall: true, marketplaceDiscoveryTimeoutMs: 4_000 },
        },
        timeoutMs: 30_000,
      }).then(
        () => {
          operationSettled = true;
        },
        () => {
          operationSettled = true;
        },
      );
      // Advance past the 4_000 ms monotonic deadline (two 2_000 ms polls).
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(2_100);
      // The loop must exit at the deadline, settling the operation before cleanup.
      expect(operationSettled).toBe(true);
      const callsAtExpiry = pluginListCalls;
      // After the deadline, no further inventory requests are made.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pluginListCalls).toBe(callsAtExpiry);
      harness.client.close();
      harness.process.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await operation;
      expect(pluginListCalls).toBeGreaterThanOrEqual(2);
      expect(pollDelays.length).toBeGreaterThan(0);
      for (const delay of pollDelays) {
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(2_000);
      }
    },
  );
});
