import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { scheduleAbsoluteDeadline } from "../../utils/absolute-deadline.js";

export class GatewayRestartDeadlineError extends Error {
  constructor(readonly phase: string) {
    super(`Gateway restart observation timed out during ${phase}.`);
    this.name = "GatewayRestartDeadlineError";
  }
}

export type GatewayRestartDeadline = ReturnType<typeof createGatewayRestartDeadline>;

/** One monotonic deadline covers setup, health, and reconciliation reads. */
export function createGatewayRestartDeadline(params: { timeoutMs: number; signal?: AbortSignal }) {
  const startedAtMs = performance.now();
  const deadlineMs = startedAtMs + params.timeoutMs;
  const controller = new AbortController();
  let activePhase: string | undefined;
  let lastPhase = "setup";
  let expiredPhase: string | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(toErrorObject(controller.signal.reason, "Gateway restart observation canceled.")),
      { once: true },
    );
  });
  // Expiry can happen between reads; the next read still observes the same rejection.
  void expired.catch(() => undefined);
  const expire = () => {
    if (!controller.signal.aborted) {
      expiredPhase = activePhase ?? lastPhase;
      controller.abort(new GatewayRestartDeadlineError(expiredPhase));
    }
  };
  const cancelTimer = scheduleAbsoluteDeadline(deadlineMs, expire, () => performance.now());
  const cancelFromCaller = () => controller.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  if (params.signal?.aborted) {
    cancelFromCaller();
  }
  return {
    deadlineMs,
    signal: controller.signal,
    get phase() {
      return activePhase ?? lastPhase;
    },
    get expiredPhase() {
      return expiredPhase;
    },
    elapsedMs: () => Math.max(0, performance.now() - startedAtMs),
    remainingMs: () => Math.max(0, deadlineMs - performance.now()),
    async read<T>(readPhase: string, operation: () => Promise<T>): Promise<T> {
      const previousPhase = activePhase;
      activePhase = readPhase;
      try {
        if (performance.now() >= deadlineMs) {
          expire();
        }
        controller.signal.throwIfAborted();
        const result = await Promise.race([expired, operation()]);
        if (performance.now() >= deadlineMs) {
          expire();
        }
        controller.signal.throwIfAborted();
        return result;
      } finally {
        activePhase = previousPhase;
        lastPhase = readPhase;
      }
    },
    dispose() {
      cancelTimer();
      params.signal?.removeEventListener("abort", cancelFromCaller);
      controller.abort(new Error("Gateway restart observation finished."));
    },
  };
}
