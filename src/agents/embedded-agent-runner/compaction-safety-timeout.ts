/**
 * Wraps compaction calls with a safety timeout and abort cleanup.
 */
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { withTimeout } from "../../node-host/with-timeout.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    return reason;
  }
  return createAbortError("aborted", reason ? { cause: reason } : undefined);
}

export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  return (
    finiteSecondsToTimerSafeMilliseconds(cfg?.agents?.defaults?.compaction?.timeoutSeconds, {
      floorSeconds: true,
    }) ?? EMBEDDED_COMPACTION_TIMEOUT_MS
  );
}

type CompactionTimeoutProvenance = {
  /** Resolved per-candidate deadline in milliseconds. */
  ms: number;
  /** Whether the deadline came from an explicit `timeoutSeconds` or the 180s default. */
  source: "configured" | "default";
};

/**
 * Resolve the per-candidate compaction deadline together with its provenance so
 * `compaction-diag` can report whether a timeout came from a configured
 * `timeoutSeconds` or the host default. #115546 asked for deadline provenance in
 * the diagnostic logs (configured vs inherited/shared budget); with the
 * chain-wide timer removed, the only sources are configured and default.
 */
export function resolveCompactionTimeoutProvenance(
  cfg?: OpenClawConfig,
): CompactionTimeoutProvenance {
  const configuredMs = finiteSecondsToTimerSafeMilliseconds(
    cfg?.agents?.defaults?.compaction?.timeoutSeconds,
    { floorSeconds: true },
  );
  return configuredMs === undefined
    ? { ms: EMBEDDED_COMPACTION_TIMEOUT_MS, source: "default" }
    : { ms: configuredMs, source: "configured" };
}

/**
 * Wrap a compaction call with a finite host-safety timeout and abort cleanup.
 *
 * This is the public {@link agent-harness-runtime} surface: plugin harnesses
 * (e.g. Codex) reuse it to bound their own `ContextEngine.compact()` with the
 * exact same finite, host-resolved watchdog the embedded-agent runner uses.
 * The public contract is therefore "a missing `timeoutMs` still bounds the
 * call with the 180s default" — `timeoutMs` defaults to
 * {@link EMBEDDED_COMPACTION_TIMEOUT_MS}, never to `undefined`, so a plugin
 * harness that omits it cannot leave compaction stuck indefinitely
 * (ClawSweeper P1: the per-operation timeout must always be honored on this
 * public path). The "no chain-wide deadline" behavior the legacy embedded
 * engine needs lives on a private path
 * ({@link compactWithoutChainDeadline}) so it cannot widen this public
 * contract.
 */
export async function compactWithSafetyTimeout<T>(
  compact: (abortSignal?: AbortSignal) => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  opts?: {
    abortSignal?: AbortSignal;
    onCancel?: () => void;
  },
): Promise<T> {
  return compactWithoutChainDeadline(compact, timeoutMs, opts);
}

/**
 * Private implementation shared by {@link compactWithSafetyTimeout} and the
 * delegating-engine path. Pass `timeoutMs: undefined` only when the caller is
 * known to run its own per-candidate watchdog chain (an engine that delegates
 * compaction to the runtime native fallback chain — trusted built-in legacy or
 * a runtime-delegating plugin — via the unexported
 * {@link compactDelegatingContextEngineWithSafetyTimeout} helper); in that case
 * `withTimeout` arms no wrapper timer and each candidate is bounded
 * independently (#115546). Every other caller must pass a finite `timeoutMs`
 * (the public default is 180s) so a hung `compact()` cannot block the turn
 * indefinitely.
 */
async function compactWithoutChainDeadline<T>(
  compact: (abortSignal?: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  opts?: {
    abortSignal?: AbortSignal;
    onCancel?: () => void;
  },
): Promise<T> {
  let canceled = false;
  const cancel = () => {
    if (canceled) {
      return;
    }
    canceled = true;
    try {
      opts?.onCancel?.();
    } catch {
      // Best-effort cancellation hook. Keep the timeout/abort path intact even
      // if the underlying compaction cancel operation throws.
    }
  };

  return await withTimeout(
    async (timeoutSignal) => {
      let timeoutListener: (() => void) | undefined;
      let externalAbortListener: (() => void) | undefined;
      let externalAbortPromise: Promise<never> | undefined;
      const abortSignal = opts?.abortSignal;
      const composedAbortSignal =
        timeoutSignal && abortSignal
          ? AbortSignal.any([timeoutSignal, abortSignal])
          : (timeoutSignal ?? abortSignal);

      if (timeoutSignal) {
        timeoutListener = () => {
          cancel();
        };
        timeoutSignal.addEventListener("abort", timeoutListener, { once: true });
      }

      if (abortSignal) {
        if (abortSignal.aborted) {
          cancel();
          throw abortErrorFromSignal(abortSignal);
        }
        externalAbortPromise = new Promise((_, reject) => {
          externalAbortListener = () => {
            cancel();
            reject(abortErrorFromSignal(abortSignal));
          };
          abortSignal.addEventListener("abort", externalAbortListener, { once: true });
        });
      }

      try {
        const compactPromise = compact(composedAbortSignal);
        if (externalAbortPromise) {
          return await Promise.race([compactPromise, externalAbortPromise]);
        }
        return await compactPromise;
      } finally {
        if (timeoutListener) {
          timeoutSignal?.removeEventListener("abort", timeoutListener);
        }
        if (externalAbortListener) {
          abortSignal?.removeEventListener("abort", externalAbortListener);
        }
      }
    },
    timeoutMs,
    "Compaction",
  );
}

/** Parameters for a single {@link ContextEngine.compact} invocation. */
type ContextEngineCompactParams = Parameters<ContextEngine["compact"]>[0];

/**
 * Invoke a {@link ContextEngine.compact} with caller cancellation and a finite
 * safety timeout. This is the public, plugin-SDK-exported surface.
 *
 * The public call contract is main's positional form
 * `(engine, params, timeoutMs?, abortSignal?)` — no options bag, no ownership
 * flag. An installed plugin harness that passes a numeric timeout and abort
 * signal positionally keeps working (ClawSweeper P1: preserve the exported
 * positional call contract; keep timeout ownership options internal).
 *
 * This public function ALWAYS applies a finite per-operation watchdog
 * ({@link resolveCompactionTimeoutMs} = `timeoutSeconds`, default 180s) and
 * threads the wrapper's composed signal (deadline + caller cancellation) into
 * `params.abortSignal` for cooperative cancellation. This matches the original
 * main-branch behavior and bounds a slow or hung `compact()` so it cannot
 * block the agent turn indefinitely.
 *
 * The "no chain-wide deadline" behavior that engines delegating compaction to
 * the runtime native fallback chain need (each fallback candidate bounded by its
 * own independent watchdog) is NOT reachable from this public function — it
 * lives on the unexported
 * {@link compactDelegatingContextEngineWithSafetyTimeout} helper, which only
 * internal call sites invoke for engines with `info.ownsCompaction !== true`
 * (trusted built-in legacy and the documented runtime-delegating plugin
 * pattern). This prevents a third-party plugin harness from passing a flag to
 * disable the finite watchdog and stall an agent turn (ClawSweeper P1: keep
 * the delegating-engine watchdog bypass private).
 *
 * Callers keep their existing try/catch — a timeout or abort surfaces as a
 * thrown error, never a silent hang.
 */
export function compactContextEngineWithSafetyTimeout(
  contextEngine: Pick<ContextEngine, "compact">,
  params: ContextEngineCompactParams,
  timeoutMs?: number,
  abortSignal?: AbortSignal,
): Promise<CompactResult> {
  // Public path: ALWAYS apply the finite per-operation watchdog. The first
  // parameter stays `Pick<ContextEngine, "compact">` (matching main); ownership
  // routing is NOT a public concern — internal call sites use the unexported
  // compactContextEngineWithSafetyTimeoutInternal helper (ClawSweeper P1:
  // preserve exported parameter type contract; keep timeout ownership options
  // internal).
  const pluginTimeoutMs = timeoutMs ?? EMBEDDED_COMPACTION_TIMEOUT_MS;
  return compactWithSafetyTimeout(
    (compactAbortSignal) =>
      contextEngine.compact(
        compactAbortSignal ? { ...params, abortSignal: compactAbortSignal } : params,
      ),
    pluginTimeoutMs,
    abortSignal ? { abortSignal } : undefined,
  );
}

/**
 * Unexported helper for engines that delegate compaction to the runtime native
 * fallback chain — i.e. any engine whose `info.ownsCompaction` is not `true`.
 *
 * This covers both the trusted built-in legacy engine and the documented
 * runtime-delegating plugin pattern (`ownsCompaction: false` with `compact()`
 * calling {@link delegateCompactionToRuntime}). Both delegate to the same
 * model-fallback candidate chain, where each candidate is bounded by its own
 * independent {@link resolveCompactionTimeoutMs} watchdog. The wrapper therefore
 * arms NO chain-wide timer — doing so would recreate #115546 (a slow candidate-1
 * erodes candidate-2's window via the shared deadline). It threads only the raw
 * caller `abortSignal` into `params.abortSignal` so caller cancellation still
 * propagates into the candidate chain (each candidate watchdog composes it with
 * its own per-candidate deadline) while each candidate keeps its own independent
 * `timeoutSeconds` window.
 *
 * This is intentionally NOT exported: a third-party plugin harness must not be
 * able to reach the no-watchdog branch by passing a flag. Callers select this
 * path based on `info.ownsCompaction !== true` (the contract that an engine
 * which does not own compaction delegates `compact()` to the runtime native
 * chain), never `info.id` which is spoofable display metadata (ClawSweeper P1:
 * keep the delegating-engine watchdog bypass private; cover the documented
 * runtime-delegating plugin mode, not only trusted core legacy).
 */
function compactDelegatingContextEngineWithSafetyTimeout(
  contextEngine: Pick<ContextEngine, "compact">,
  params: ContextEngineCompactParams,
  opts?: { abortSignal?: AbortSignal },
): Promise<CompactResult> {
  const callerAbortSignal = opts?.abortSignal;
  // Arm no wrapper timer — each candidate is bounded by its own
  // resolveCompactionTimeoutMs watchdog (#115546 fix), and a wrapper-imposed
  // chain deadline would recreate the shared-deadline defect. Thread only the
  // raw caller abortSignal into params.abortSignal so caller cancellation still
  // flows through to the candidate chain (the per-candidate executor composes
  // it with its own watchdog, preserving the caller-cancels-in-flight-candidate
  // invariant while keeping each candidate's window independent). This uses
  // the private compactWithoutChainDeadline path explicitly passing
  // `undefined`, NOT the public compactWithSafetyTimeout — the public path
  // must always default to the finite 180s watchdog (ClawSweeper P1), so the
  // no-chain-deadline behavior must not be reachable by omitting the public
  // timeout argument.
  return compactWithoutChainDeadline(
    (compactAbortSignal) =>
      contextEngine.compact(
        compactAbortSignal ? { ...params, abortSignal: compactAbortSignal } : params,
      ),
    undefined,
    callerAbortSignal ? { abortSignal: callerAbortSignal } : undefined,
  );
}

/**
 * Internal entry point for host compaction call sites. Selects between the
 * no-chain-deadline path (engines that delegate compaction to the runtime
 * native fallback chain) and the public finite-watchdog path (engines that own
 * their compaction algorithm), based on `info.ownsCompaction`. Not exported:
 * the public SDK surface is {@link compactContextEngineWithSafetyTimeout}
 * (finite watchdog always on).
 */
export function compactContextEngineWithSafetyTimeoutInternal(
  contextEngine: Pick<ContextEngine, "compact">,
  params: ContextEngineCompactParams,
  opts: {
    /** contextEngine.info.ownsCompaction === true. */
    ownsCompaction: boolean;
    pluginTimeoutMs?: number;
    abortSignal?: AbortSignal;
  },
): Promise<CompactResult> {
  if (!opts.ownsCompaction) {
    // Engines that do not own compaction (trusted built-in legacy AND the
    // documented runtime-delegating plugin pattern whose compact() calls
    // delegateCompactionToRuntime) enter the same native per-candidate fallback
    // chain, where each candidate is bounded by its own independent
    // resolveCompactionTimeoutMs watchdog. Arm no wrapper timer — a chain-wide
    // deadline would recreate #115546 (slow candidate-1 erodes candidate-2's
    // window). Caller cancellation still threads through params.abortSignal.
    return compactDelegatingContextEngineWithSafetyTimeout(
      contextEngine,
      params,
      opts.abortSignal ? { abortSignal: opts.abortSignal } : undefined,
    );
  }
  // ownsCompaction engines: the public finite-watchdog path. The wrapper always
  // applies the finite per-operation watchdog (pluginTimeoutMs, default 180s)
  // so a slow self-owned compact() cannot block the agent turn indefinitely
  // (Round 8 timeoutSeconds contract preserved). This keeps ownership routing
  // fully internal (ClawSweeper P1: keep timeout ownership options internal).
  return compactContextEngineWithSafetyTimeout(
    contextEngine,
    params,
    opts.pluginTimeoutMs,
    opts.abortSignal,
  );
}
