// Covers safety timeouts around embedded-agent compaction calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";
import {
  compactContextEngineWithSafetyTimeout,
  compactContextEngineWithSafetyTimeoutInternal,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
  resolveCompactionTimeoutProvenance,
} from "./embedded-agent-runner/compaction-safety-timeout.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

describe("compactWithSafetyTimeout", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("rejects with timeout when compaction never settles", async () => {
    // Hung compaction must not stall the agent turn indefinitely.
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(
      () => new Promise<never>(() => {}),
      EMBEDDED_COMPACTION_TIMEOUT_MS,
    );
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns result and clears timer when compaction settles first", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("ok"), 10);
        }),
      30,
    );

    await vi.advanceTimersByTimeAsync(10);
    await expect(compactPromise).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves compaction errors and clears timer", async () => {
    vi.useFakeTimers();
    const error = new Error("provider exploded");

    await expect(
      compactWithSafetyTimeout(async () => {
        throw error;
      }, 30),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls onCancel when compaction times out", async () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();

    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 30, {
      onCancel,
    });
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await timeoutAssertion;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts early on external abort signal and calls onCancel once", async () => {
    // Run-level aborts should win over the safety timer and still trigger one
    // cancellation path.
    vi.useFakeTimers();
    const controller = new AbortController();
    const onCancel = vi.fn();
    const reason = new Error("request timed out");

    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 100, {
      abortSignal: controller.signal,
      onCancel,
    });
    const abortAssertion = expect(compactPromise).rejects.toBe(reason);

    controller.abort(reason);
    await abortAssertion;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores onCancel errors and still rejects with the timeout", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 30, {
      onCancel: () => {
        throw new Error("abortCompaction failed");
      },
    });
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to the 180s host watchdog when timeoutMs is omitted (ClawSweeper P1)", async () => {
    // Public-contract regression: compactWithSafetyTimeout is exported on the
    // plugin-sdk agent-harness-runtime surface, so a plugin harness that omits
    // timeoutMs must still be bounded by the 180s default — never left with no
    // timer (which would let a hung compact() block the turn indefinitely). The
    // no-chain-deadline behavior the legacy embedded engine needs lives on a
    // private path and must not leak into this public default.
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}));
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    // No timer fires before the 180s default deadline…
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS - 1);

    // …but it does fire at the 180s default backstop.
    await vi.advanceTimersByTimeAsync(1);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveCompactionTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveCompactionTimeoutMs(undefined)).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default when compaction config is missing", () => {
    expect(resolveCompactionTimeoutMs({ agents: { defaults: {} } })).toBe(
      EMBEDDED_COMPACTION_TIMEOUT_MS,
    );
  });

  it("returns default when timeoutSeconds is not set", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { mode: "safeguard" } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("converts timeoutSeconds to milliseconds", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 120 } } },
      }),
    ).toBe(120_000);
  });

  it("preserves explicit timeoutSeconds above 600", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 1800 } } },
      }),
    ).toBe(1_800_000);
  });

  it("floors fractional seconds", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 120.7 } } },
      }),
    ).toBe(120_000);
  });

  it("returns default for zero", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { timeoutSeconds: 0 } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for negative values", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { timeoutSeconds: -5 } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for NaN", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: Number.NaN } } },
      }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for Infinity", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: Infinity } } },
      }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });
});

describe("resolveCompactionTimeoutProvenance", () => {
  it("reports the default source when no timeoutSeconds is configured", () => {
    expect(resolveCompactionTimeoutProvenance(undefined)).toEqual({
      ms: EMBEDDED_COMPACTION_TIMEOUT_MS,
      source: "default",
    });
    expect(
      resolveCompactionTimeoutProvenance({
        agents: { defaults: { compaction: { mode: "safeguard" } } },
      }),
    ).toEqual({ ms: EMBEDDED_COMPACTION_TIMEOUT_MS, source: "default" });
  });

  it("reports the configured source and resolved ms when timeoutSeconds is set", () => {
    expect(
      resolveCompactionTimeoutProvenance({
        agents: { defaults: { compaction: { timeoutSeconds: 30 } } },
      }),
    ).toEqual({ ms: 30_000, source: "configured" });
  });
});

describe("compactContextEngineWithSafetyTimeout", () => {
  type CompactFn = ContextEngine["compact"];
  const baseParams: Parameters<CompactFn>[0] = {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    tokenBudget: 100_000,
    force: true,
  };
  // Engine ownership routing is fully internal: the public surface takes only
  // positional (engine, params, timeoutMs?, abortSignal?) with no ownership
  // flag, while the unexported internal helper carries ownsCompaction. Test
  // engines are minimal `{ compact }` objects — matching the public
  // `Pick<ContextEngine, "compact">` contract (ClawSweeper P1: keep timeout
  // ownership options internal).

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("bounds a hung plugin compact() and rejects with a timeout error", async () => {
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the plugin compact() result when it settles in time", async () => {
    const result: CompactResult = {
      ok: true,
      compacted: true,
      result: { tokensBefore: 1000, tokensAfter: 200 },
    };
    const compact = vi.fn<CompactFn>(async () => result);

    await expect(compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30)).resolves.toBe(
      result,
    );
  });

  it("threads a signal that follows the run abort signal into the plugin compact() params", async () => {
    // Plugin context engines receive an abort signal derived from the run signal
    // so they can stop work promptly.
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("run aborted");
    let compactAbortSignal: AbortSignal | undefined;
    const compact = vi.fn<CompactFn>((params) => {
      compactAbortSignal = params.abortSignal;
      return new Promise<CompactResult>(() => {});
    });

    const pending = compactContextEngineWithSafetyTimeout(
      { compact },
      baseParams,
      30,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toBe(reason);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compactAbortSignal).toBeInstanceOf(AbortSignal);
    expect(compactAbortSignal?.aborted).toBe(false);

    controller.abort(reason);
    await assertion;
    expect(compactAbortSignal?.aborted).toBe(true);
    expect(compactAbortSignal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects promptly when the run abort signal fires before the timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new Error("run aborted");
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout(
      { compact },
      baseParams,
      EMBEDDED_COMPACTION_TIMEOUT_MS,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toBe(abortError);

    controller.abort(abortError);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies no chain deadline for the trusted built-in legacy engine but still honors caller cancellation", async () => {
    // The trusted built-in legacy engine (verified via
    // resolveContextEngineIsTrustedLegacy — NOT info.id, which is spoofable)
    // delegates compact() to the runtime native per-candidate fallback chain,
    // where each candidate is bounded by its own resolveCompactionTimeoutMs
    // watchdog. The internal helper must NOT arm a chain-wide timer — doing so
    // would recreate #115546. Caller cancellation remains the only external
    // abort path and must work.
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new Error("run aborted");
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeoutInternal({ compact }, baseParams, {
      legacyDelegating: true,
      ownsCompaction: false,
      abortSignal: controller.signal,
    });
    const assertion = expect(pending).rejects.toBe(abortError);

    // No chain timer is armed, so advancing time does not abort on its own.
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);

    controller.abort(abortError);
    await assertion;
  });

  it("threads the raw caller abort signal into the embedded compact() params", async () => {
    // The trusted legacy engine runs the candidate chain internally; each
    // candidate is bounded by its own resolveCompactionTimeoutMs watchdog. The
    // wrapper must still forward the raw caller signal via params.abortSignal
    // so a caller cancellation aborts the in-flight candidate (the candidate
    // executor composes it with its own per-candidate deadline). This mirrors
    // the plugin-owned path: caller cancellation must not be lost when the
    // wrapper arms no chain timer.
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("run aborted");
    let compactAbortSignal: AbortSignal | undefined;
    const compact = vi.fn<CompactFn>((params) => {
      compactAbortSignal = params.abortSignal;
      return new Promise<CompactResult>(() => {});
    });

    const pending = compactContextEngineWithSafetyTimeoutInternal({ compact }, baseParams, {
      legacyDelegating: true,
      ownsCompaction: false,
      abortSignal: controller.signal,
    });
    const assertion = expect(pending).rejects.toBe(reason);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compactAbortSignal).toBeInstanceOf(AbortSignal);
    expect(compactAbortSignal?.aborted).toBe(false);

    // No chain timer is armed; the caller signal is the only external abort.
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);

    controller.abort(reason);
    await assertion;
    expect(compactAbortSignal?.aborted).toBe(true);
    expect(compactAbortSignal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a thrown plugin compaction error", async () => {
    const error = new Error("engine compaction failed");
    const compact = vi.fn<CompactFn>(async () => {
      throw error;
    });

    await expect(compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30)).rejects.toBe(
      error,
    );
  });

  it("keeps the 180s default watchdog for a plugin-owned engine when timeoutMs is unset", async () => {
    // ClawSweeper P1 regression: ownsCompaction engines do not delegate to the
    // native per-candidate chain, so the public wrapper must still bound a hung
    // plugin compact() with the 180s default — otherwise the turn hangs
    // indefinitely.
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout({ compact }, baseParams);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    // No 180s timer fires before the deadline…
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS - 1);
    expect(compact).toHaveBeenCalledTimes(1);

    // …but it does fire at the 180s default backstop.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies no default watchdog for the trusted legacy engine when timeoutMs is unset", async () => {
    // #115546 regression: the embedded path runs the candidate chain internally,
    // each candidate bounded by its own resolveCompactionTimeoutMs watchdog —
    // but ONLY for the trusted built-in legacy engine (registry identity). The
    // wrapper must NOT arm a chain-wide 180s timer by default — that would let
    // a slow candidate-1 erode candidate-2's window via the shared deadline.
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new Error("run aborted");
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeoutInternal({ compact }, baseParams, {
      legacyDelegating: true,
      ownsCompaction: false,
      abortSignal: controller.signal,
    });

    // Well past the 180s default — no timer is armed, so the pending compact()
    // is NOT rejected. Only caller cancellation can abort it.
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
    expect(compact).toHaveBeenCalledTimes(1);

    controller.abort(abortError);
    await expect(pending).rejects.toBe(abortError);
  });

  it("keeps the finite watchdog for a runtime-delegating plugin engine without trusted-core identity (ClawSweeper P1)", async () => {
    // ClawSweeper P1: ownsCompaction false-or-unset does NOT prove the engine
    // delegates compact() to the runtime native fallback chain. The documented
    // runtime-delegating plugin pattern sets ownsCompaction: false and calls
    // delegateCompactionToRuntime, but a plugin cannot be trusted by identity
    // (owner is plugin:xxx, not "core") — so it must keep the finite host
    // watchdog. Only the trusted built-in legacy engine (registry identity,
    // legacyDelegating) receives the no-chain per-candidate path. This guards a
    // hung non-delegating plugin from blocking /compact indefinitely.
    vi.useFakeTimers();
    // Simulated runtime-delegating plugin engine: ownsCompaction: false and
    // legacyDelegating: false (not trusted core). A hung compact() must still be
    // bounded by the finite host watchdog.
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeoutInternal({ compact }, baseParams, {
      legacyDelegating: false,
      ownsCompaction: false,
      pluginTimeoutMs: resolveCompactionTimeoutMs(),
    });
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    // No timer fires before the 180s backstop…
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS - 1);
    expect(compact).toHaveBeenCalledTimes(1);

    // …but it does fire at the finite watchdog, even though ownsCompaction is
    // false — proving delegation alone is not trusted without core identity.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a configured timeoutSeconds for a plugin-owned engine instead of the 180s default (ClawSweeper P1)", async () => {
    // Regression guard: an ownsCompaction engine must use the per-operation
    // timeout (resolveCompactionTimeoutMs = timeoutSeconds) as its finite
    // watchdog. Before Round 8, call sites passed a chain timeout that defaulted
    // to undefined, so pluginTimeoutMs = undefined ?? 180_000 collapsed a
    // configured timeoutSeconds:30 to 180s — an ownsCompaction engine waited
    // 180s where it was configured to wait 30s.
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    // resolveCompactionTimeoutMs({agents:{defaults:{compaction:{timeoutSeconds:30}}}}) = 30_000.
    // This is the value the updated call sites pass as the positional timeoutMs.
    const pending = compactContextEngineWithSafetyTimeout(
      { compact },
      baseParams,
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 30 } } },
      }),
    );
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    // The 30s per-operation timeout fires — NOT the 180s default.
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the finite watchdog for a third-party engine without ownership metadata (ClawSweeper P1)", async () => {
    // ownsCompaction is optional in the context-engine contract. The public
    // `compactContextEngineWithSafetyTimeout` surface ALWAYS applies the finite
    // host safety timeout regardless of ownership — the no-chain bypass lives
    // only on the unexported internal helper. So an engine that omits the
    // metadata (or declares false) calling through the public surface must NOT
    // lose the finite host safety timeout — otherwise a hung third-party
    // compact() blocks the agent turn indefinitely.
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout({ compact }, baseParams);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    // No 180s timer fires before the deadline…
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS - 1);
    expect(compact).toHaveBeenCalledTimes(1);

    // …but it does fire at the 180s default backstop.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the finite watchdog for a hung non-delegating engine via the internal helper (ClawSweeper P1)", async () => {
    // ClawSweeper P1 regression: a custom engine with ownsCompaction false or
    // absent is NOT proven to delegate compact() to the native fallback chain.
    // The internal helper must therefore keep the finite host watchdog on this
    // path — a hung compact() on /compact or overflow recovery must not block
    // the agent turn indefinitely. Only the trusted built-in legacy engine
    // (legacyDelegating: true) reaches the no-chain per-candidate path.
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeoutInternal({ compact }, baseParams, {
      legacyDelegating: false,
      ownsCompaction: false,
      pluginTimeoutMs: resolveCompactionTimeoutMs(),
    });
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    // No 180s timer fires before the deadline…
    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS - 1);
    expect(compact).toHaveBeenCalledTimes(1);

    // …but it does fire at the 180s backstop, even though ownsCompaction is
    // false and no abort signal was supplied.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the watchdog for a third-party engine spoofing the legacy info.id (ClawSweeper P1)", async () => {
    // `ContextEngine.info.id` is display metadata, not a trusted signal: a
    // third-party engine may legally report `id: "legacy"` while registered
    // under another slot. The no-timer bypass lives on the unexported
    // `compactContextEngineWithSafetyTimeoutInternal` helper and is gated on
    // trusted core-legacy registry identity (`legacyDelegating`), never
    // `info.id` — so a spoofed metadata id cannot remove the finite host
    // watchdog. The public `compactContextEngineWithSafetyTimeout` surface has
    // no ownership option at all and applies the finite watchdog
    // unconditionally; a third-party harness cannot opt out regardless of
    // info.id.
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout(
      { compact },
      baseParams,
      // The public surface has no ownership option at all — a third-party
      // harness cannot opt out of the finite watchdog regardless of info.id.
    );
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors the positional timeoutMs and abortSignal contract (ClawSweeper P1)", async () => {
    // Public-contract regression: compactContextEngineWithSafetyTimeout is
    // exported on the plugin-sdk agent-harness-runtime surface, and its
    // signature is the positional (engine, params, timeoutMs?, abortSignal?) —
    // no options bag, no ownership flag (ClawSweeper P1: keep timeout ownership
    // options internal). An installed plugin harness calling positionally must
    // keep working: the numeric timeoutMs is honored (NOT silently dropped) and
    // the positional abortSignal still propagates.
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new Error("run aborted");
    let compactAbortSignal: AbortSignal | undefined;
    const compact = vi.fn<CompactFn>((params) => {
      compactAbortSignal = params.abortSignal;
      return new Promise<CompactResult>(() => {});
    });

    // Positional form: timeoutMs=30 is the per-operation watchdog.
    const pending = compactContextEngineWithSafetyTimeout(
      { compact },
      baseParams,
      30,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toBe(abortError);

    // The positional abortSignal reached the engine's composed signal.
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compactAbortSignal).toBeInstanceOf(AbortSignal);
    expect(compactAbortSignal?.aborted).toBe(false);

    controller.abort(abortError);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors the positional timeoutMs as the per-operation watchdog (ClawSweeper P1)", async () => {
    // The positional timeoutMs must bind the finite watchdog, not be ignored.
    // A plugin-owned engine with a hung compact() and positional timeoutMs=30
    // must reject at ~30ms — proving the positional contract is preserved end
    // to end (main passed timeoutMs straight to the watchdog wrapper).
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    // No timer fires before the 30ms positional deadline…
    await vi.advanceTimersByTimeAsync(29);
    expect(compact).toHaveBeenCalledTimes(1);

    // …but it does fire at the 30ms positional watchdog.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("per-candidate window and chain-deadline cancellation", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("gives a later candidate its own full window after the previous one burned its budget", async () => {
    // With no chain-wide backstop (the default), each candidate's watchdog is
    // independent: candidate 2 starts with a fresh full window even though
    // candidate 1 consumed its own entire budget. This is the core invariant
    // the fix restores — the legacy shared deadline left candidate 2 only the
    // leftover from candidate 1.
    vi.useFakeTimers();
    const perCandidateMs = 30;

    // Candidate 1 hangs and is cut by its own per-candidate watchdog. Consume
    // the rejection explicitly so it does not surface as an unhandled error.
    const candidate1 = compactWithSafetyTimeout(
      () => new Promise<never>(() => {}),
      perCandidateMs,
      {
        onCancel: () => {},
      },
    );
    const candidate1Outcome = candidate1.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(perCandidateMs);
    await expect(candidate1Outcome).resolves.toBe("rejected");

    // Candidate 2 starts fresh with its own full window — no shared deadline
    // can cut it short.
    const candidate2 = compactWithSafetyTimeout(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("ok"), perCandidateMs - 10);
        }),
      perCandidateMs,
      {
        onCancel: () => {},
      },
    );
    await vi.advanceTimersByTimeAsync(perCandidateMs - 10);
    await expect(candidate2).resolves.toBe("ok");
  });
});
