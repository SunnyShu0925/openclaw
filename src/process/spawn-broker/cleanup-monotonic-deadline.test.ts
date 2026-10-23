import { afterEach, expect, it, vi } from "vitest";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { drainCurrentBrokerProcessGroup } from "./cleanup.js";

const boundary = vi.hoisted(() => ({ census: vi.fn(), identity: vi.fn(), dead: vi.fn() }));
vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...timers,
    // Route through the global timer so vi.useFakeTimers can drive the join loop.
    setTimeout: (ms: number) =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, ms);
      }),
  };
});
vi.mock("../supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supervisor/service-child-group-ownership.js")>()),
  readProcessGroupMembers: boundary.census,
}));
vi.mock("../../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/pid-alive.js")>()),
  getProcessInstanceStartTime: boundary.identity,
  isPidDefinitelyDead: boundary.dead,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.skipIf(process.platform === "win32")(
  "escalates a stuck member to SIGKILL on the monotonic clock when the wall clock rewinds",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const owner = { pid: process.pid, pgid: process.pid, state: "S" };
    const stuck = { pid: 123456789, pgid: process.pid, state: "S" };
    boundary.census.mockReturnValue([owner, stuck]);
    boundary.identity.mockReturnValue(7);
    boundary.dead.mockReturnValue(false);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    const settled = drainCurrentBrokerProcessGroup();
    // A backward wall-clock step (NTP correction, VM or laptop resume) after the
    // deadline was seeded must not postpone the SIGTERM -> SIGKILL escalation.
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(GRACEFUL_CANCEL_TIMEOUT_MS + 1_000);

    const signals = kill.mock.calls.map(([, signal]) => signal);
    expect(signals).toContain("SIGKILL");
    expect(signals.some((signal) => signal === "SIGTERM")).toBe(true);

    boundary.census.mockReturnValue([owner]);
    boundary.dead.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(50);
    await settled;
  },
);
