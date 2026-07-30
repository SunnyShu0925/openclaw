/**
 * Owns the run deadline, compaction grace, and external abort listener.
 */
import { isSignalTimeoutReason } from "../../failover-error.js";
import type { AgentSession } from "../../sessions/index.js";
import { log } from "../logger.js";
import {
  resolveRunTimeoutDuringCompaction,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptCompactionState = {
  isCompacting(): boolean;
};

type EmbeddedAttemptTimeoutParams = Pick<
  EmbeddedRunAttemptParams,
  "abortSignal" | "onAttemptTimeoutArmed" | "runId" | "sessionId" | "timeoutMs"
>;

function getAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

export function prepareEmbeddedAttemptTimeout(input: {
  attempt: EmbeddedAttemptTimeoutParams;
  activeSession: Pick<AgentSession, "isCompacting" | "isStreaming">;
  compactionState: AttemptCompactionState;
  compactionTimeoutMs: number;
  isProbeSession: boolean;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  markTimedOutDuringCompaction: () => void;
  markTimedOutByRunBudget: () => void;
}) {
  const { activeSession, attempt } = input;
  const runStartMs = Date.now();
  let abortWarnTimer: NodeJS.Timeout | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  let runAbortDeadlineAtMs = Date.now() + attempt.timeoutMs;
  let compactionGraceUsed = false;
  let totalExtendedMs = 0;
  let lastActivityAtMs = Date.now();
  const MAX_EXTENSION_TOTAL_MS = 120_000;

  const scheduleAbortTimer = (delayMs: number, reason: "initial" | "compaction-grace") => {
    if (abortTimer) {
      clearTimeout(abortTimer);
    }
    runAbortDeadlineAtMs = Date.now() + Math.max(1, delayMs);
    abortTimer = setTimeout(
      () => {
        const timeoutAction = resolveRunTimeoutDuringCompaction({
          isCompactionPendingOrRetrying: input.compactionState.isCompacting(),
          isCompactionInFlight: activeSession.isCompacting,
          graceAlreadyUsed: compactionGraceUsed,
        });
        if (timeoutAction === "extend") {
          compactionGraceUsed = true;
          if (!input.isProbeSession) {
            log.warn(
              `embedded run timeout reached during compaction; extending deadline: ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId} extraMs=${input.compactionTimeoutMs}`,
            );
          }
          scheduleAbortTimer(input.compactionTimeoutMs, "compaction-grace");
          return;
        }

        if (!input.isProbeSession) {
          log.warn(
            reason === "compaction-grace"
              ? `embedded run timeout after compaction grace: runId=${attempt.runId} sessionId=${attempt.sessionId} timeoutMs=${attempt.timeoutMs} compactionGraceMs=${input.compactionTimeoutMs}`
              : `embedded run timeout: runId=${attempt.runId} sessionId=${attempt.sessionId} timeoutMs=${attempt.timeoutMs}`,
          );
        }
        if (
          shouldFlagCompactionTimeout({
            isTimeout: true,
            isCompactionPendingOrRetrying: input.compactionState.isCompacting(),
            isCompactionInFlight: activeSession.isCompacting,
          })
        ) {
          input.markTimedOutDuringCompaction();
        }
        input.markTimedOutByRunBudget();
        input.abortRun(true);
        if (!abortWarnTimer) {
          abortWarnTimer = setTimeout(() => {
            if (!activeSession.isStreaming) {
              return;
            }
            if (!input.isProbeSession) {
              log.warn(
                `embedded run abort still streaming: runId=${attempt.runId} sessionId=${attempt.sessionId}`,
              );
            }
          }, 10_000);
        }
      },
      Math.max(1, delayMs),
    );
  };

  scheduleAbortTimer(attempt.timeoutMs, "initial");
  attempt.onAttemptTimeoutArmed?.();

  const onAbort = () => {
    input.markExternalAbort();
    const reason = attempt.abortSignal ? getAbortReason(attempt.abortSignal) : undefined;
    const timeout = reason ? isSignalTimeoutReason(reason) : false;
    if (
      shouldFlagCompactionTimeout({
        isTimeout: timeout,
        isCompactionPendingOrRetrying: input.compactionState.isCompacting(),
        isCompactionInFlight: activeSession.isCompacting,
      })
    ) {
      input.markTimedOutDuringCompaction();
    }
    input.abortRun(timeout, reason);
  };
  if (attempt.abortSignal) {
    if (attempt.abortSignal.aborted) {
      onAbort();
    } else {
      attempt.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /** Tracks whether the absolute cap abort has already fired, so repeated
   * noteActivity() calls past maxDeadline are idempotent — they do not
   * re-invoke abortRun, re-release the session lock, or re-trigger
   * onAttemptTimeout. */
  let hasAbortedAtCap = false;

  /** Resets the run budget deadline on activity, subject to hard caps.
   * Uses actual wall-clock elapsed time since last activity for the total
   * extension cap, making MAX_EXTENSION_TOTAL_MS a meaningful timeout ceiling
   * rather than a fixed multiple of the initial timeoutMs.
   * The deadline is clamped to runStartMs + max(timeoutMs, MAX_EXTENSION_TOTAL_MS) to prevent
   * unbounded extension from a progress event near the cap boundary.
   * Note: there is no extension-count cutoff — only the absolute
   * run-start deadline bounds the sliding window, so a legitimate embedded
   * run with many progress events can keep extending until the cap. */
  const noteActivity = () => {
    // Once the absolute cap abort has fired, all subsequent progress events
    // are no-ops — re-calling abortRun/markTimedOutByRunBudget is not
    // idempotent and can trigger side-effects (onAttemptTimeout, session
    // lock release, run-abandoned markers).
    if (hasAbortedAtCap) {
      return;
    }

    const now = Date.now();
    const elapsedSinceLastActivity = Math.max(0, now - lastActivityAtMs);
    lastActivityAtMs = now;
    totalExtendedMs += elapsedSinceLastActivity;

    // Effective max runtime: the absolute cap is at least the configured
    // timeoutMs, so users with longer budgets (e.g. 180s) are not silently
    // reduced by the hard-coded floor. For small timeouts the floor acts as
    // a reasonable ceiling to prevent unbounded extension.
    const effectiveMaxRunMs = Math.max(attempt.timeoutMs, MAX_EXTENSION_TOTAL_MS);
    const maxDeadline = runStartMs + effectiveMaxRunMs;

    if (now >= maxDeadline) {
      // Absolute cap reached — abort once. Clear the already-armed abort
      // timer to prevent a stale callback from firing alongside this
      // immediate abort, then set the terminal flag so subsequent progress
      // events become no-ops.
      hasAbortedAtCap = true;
      clearTimeout(abortTimer);
      input.markTimedOutByRunBudget();
      input.abortRun(true);
      return;
    }

    const newDeadline = Math.min(now + attempt.timeoutMs, maxDeadline);
    const delayMs = Math.max(1, newDeadline - now);
    scheduleAbortTimer(delayMs, "initial");
  };

  return {
    getRunAbortDeadlineAtMs: () => runAbortDeadlineAtMs,
    noteActivity,
    clearTimers: () => {
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      if (abortWarnTimer) {
        clearTimeout(abortWarnTimer);
      }
    },
    removeAbortSignalListener: () => {
      attempt.abortSignal?.removeEventListener("abort", onAbort);
    },
  };
}
