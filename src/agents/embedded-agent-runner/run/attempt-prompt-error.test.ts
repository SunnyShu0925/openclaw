import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  handleMidTurnPrecheckRequest: vi.fn(),
  isMidTurnPrecheckSignal: vi.fn(() => false),
  isSessionsYieldAbortError: vi.fn(() => false),
  markYieldAborted: vi.fn(),
  persistSessionsYieldContextMessage: vi.fn(async () => undefined),
  releaseLeasedSteering: vi.fn(),
  stripSessionsYieldArtifacts: vi.fn(),
  waitForSessionsYieldAbortSettle: vi.fn(async () => undefined),
  withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
}));

vi.mock("./attempt-sessions-yield.js", () => ({
  isSessionsYieldAbortError: hoisted.isSessionsYieldAbortError,
  persistSessionsYieldContextMessage: hoisted.persistSessionsYieldContextMessage,
  stripSessionsYieldArtifacts: hoisted.stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle: hoisted.waitForSessionsYieldAbortSettle,
}));
vi.mock("./midturn-precheck.js", () => ({
  isMidTurnPrecheckSignal: hoisted.isMidTurnPrecheckSignal,
}));

import { abortable, isOpenClawAbortableWrapper } from "./abortable.js";
import { isRunBudgetTimeoutAbortReason } from "./attempt-finalize.js";
import { handleEmbeddedAttemptPromptError } from "./attempt-prompt-submit.js";

// Mirrors the private createTimeoutAbortReason() in attempt-finalize.ts (the
// production reason is intentionally not exported to keep the public surface
// minimal — knip's production unused-export scan treats test imports as out of
// scope). The Symbol.for key is the stable contract the exemption matches on.
const RUN_BUDGET_TIMEOUT_ABORT = Symbol.for("openclaw.abortable.run_budget_timeout");
function createTimeoutAbortReason(): Error {
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  (error as Error & { [RUN_BUDGET_TIMEOUT_ABORT]?: true })[RUN_BUDGET_TIMEOUT_ABORT] = true;
  return error;
}

type PromptErrorInput = Parameters<typeof handleEmbeddedAttemptPromptError>[0];

function createInput(overrides: Partial<PromptErrorInput> = {}): PromptErrorInput {
  return {
    activeSession: { agent: { state: { messages: [] } }, messages: [] },
    attempt: { runId: "run-1", sessionId: "session-1" },
    error: new Error("prompt failed"),
    handleMidTurnPrecheckRequest: hoisted.handleMidTurnPrecheckRequest,
    markYieldAborted: hoisted.markYieldAborted,
    releaseLeasedSteering: hoisted.releaseLeasedSteering,
    withOwnedTranscriptWrite: hoisted.withOwnedTranscriptWrite,
    yieldAbortSettled: null,
    yieldDetected: false,
    yieldMessage: null,
    ...overrides,
  } as PromptErrorInput;
}

describe("handleEmbeddedAttemptPromptError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.isMidTurnPrecheckSignal.mockReturnValue(false);
    hoisted.isSessionsYieldAbortError.mockReturnValue(false);
  });

  it("returns ordinary provider failures to the prompt state owner", async () => {
    const error = new Error("provider failed");

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({
      promptFailure: { error, source: "prompt" },
    });

    expect(hoisted.releaseLeasedSteering).toHaveBeenCalledWith(error);
  });

  it("exempts a run-budget timeout abort so the terminal stays failure-free for salvage", async () => {
    // Production path: attempt-timeout-prepare.ts fires abortRun(true) ->
    // createEmbeddedAttemptRunAbort aborts the controller with
    // createTimeoutAbortReason(); abortable() wraps the rejected prompt as an
    // AbortError whose cause is the tagged timeout reason. This is not a
    // provider failure — attaching it would mark the terminal `failed` and
    // defeat the failure-free salvage gate in attempt-settle.ts (ClawSweeper P1,
    // 08-18 round / #119935).
    const controller = new AbortController();
    const timeoutReason = createTimeoutAbortReason();
    controller.abort(timeoutReason);
    // abortable() rejects with makeAbortError(signal): name=AbortError, cause=reason,
    // tagged with the OPENCLAW_ABORTABLE_WRAPPER symbol.
    await expect(abortable(controller.signal, new Promise<void>(() => {}))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        err.name === "AbortError" &&
        isOpenClawAbortableWrapper(err) &&
        isRunBudgetTimeoutAbortReason((err as { cause?: unknown }).cause),
    );

    const error = await abortable(controller.signal, new Promise<void>(() => {})).catch(
      (err: unknown) => err as Error,
    );

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({});

    expect(hoisted.releaseLeasedSteering).toHaveBeenCalledWith(error);
  });

  it("still returns non-timeout abort wrappers as prompt failures", async () => {
    // An external cancellation (abortRun(false) with a non-timeout reason) also
    // produces an abortable wrapper, but its cause is not the tagged run-budget
    // timeout reason — it must still surface as a promptFailure so external
    // cancellations are not silently salvaged.
    const controller = new AbortController();
    controller.abort(new Error("external cancellation"));
    const error = await abortable(controller.signal, new Promise<void>(() => {})).catch(
      (err: unknown) => err as Error,
    );

    expect(isOpenClawAbortableWrapper(error)).toBe(true);
    expect(isRunBudgetTimeoutAbortReason((error as { cause?: unknown }).cause)).toBe(false);

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({
      promptFailure: { error, source: "prompt" },
    });
  });

  it("routes mid-turn prechecks under the owned transcript context", async () => {
    const request = {
      route: "compact_only",
      estimatedPromptTokens: 12,
      promptBudgetBeforeReserve: 10,
      overflowTokens: 2,
      toolResultReducibleChars: 0,
      effectiveReserveTokens: 1,
    } as const;
    const error = { request };
    hoisted.isMidTurnPrecheckSignal.mockReturnValue(true);

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({});

    expect(hoisted.withOwnedTranscriptWrite).toHaveBeenCalledOnce();
    expect(hoisted.handleMidTurnPrecheckRequest).toHaveBeenCalledWith(request);
  });

  it("settles yield aborts, strips artifacts, and persists handoff context", async () => {
    const settlePromise = Promise.resolve();
    const error = new Error("yield handoff");
    const input = createInput({
      error,
      yieldAbortSettled: settlePromise,
      yieldDetected: true,
      yieldMessage: "wait for follow-up",
    });
    hoisted.isSessionsYieldAbortError.mockReturnValue(true);

    await expect(handleEmbeddedAttemptPromptError(input)).resolves.toEqual({});

    expect(hoisted.markYieldAborted).toHaveBeenCalledOnce();
    expect(hoisted.waitForSessionsYieldAbortSettle).toHaveBeenCalledWith({
      settlePromise,
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(hoisted.stripSessionsYieldArtifacts).toHaveBeenCalledWith(input.activeSession);
    expect(hoisted.persistSessionsYieldContextMessage).toHaveBeenCalledWith(
      input.activeSession,
      "wait for follow-up",
    );
  });

  it("marks yield state before fallible recovery begins", async () => {
    const recoveryError = new Error("settle failed");
    let marked = false;
    hoisted.isSessionsYieldAbortError.mockReturnValue(true);
    hoisted.waitForSessionsYieldAbortSettle.mockImplementationOnce(async () => {
      expect(marked).toBe(true);
      throw recoveryError;
    });

    await expect(
      handleEmbeddedAttemptPromptError(
        createInput({
          error: new Error("yield handoff"),
          markYieldAborted: () => {
            marked = true;
          },
          yieldDetected: true,
        }),
      ),
    ).rejects.toBe(recoveryError);
  });
});
