import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../infra/diagnostic-model-request.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../logging/diagnostic-run-activity.js";
import {
  classifySessionAttention,
  isRepeatedModelRequestStalled,
} from "../logging/diagnostic-session-attention.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { createModelObserver } from "./embedded-agent-runner/run/attempt.model-diagnostic-observation.js";
import type { AnyAgentTool } from "./tools/common.js";

// Mirrors the production watchdog's repeated-request abort threshold. The
// evidence clock starts at the first repeated request, so advancing past this
// boundary exercises the same final cancellation decision the heartbeat makes.
const STUCK_SESSION_ABORT_MS = 30_000;

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
  resetDiagnosticSessionStateForTest();
});

it.each(["completed", "error", "blocked", "retired-during-execution", "retired-before-delivery"])(
  "accounts for %s tool execution independently of a length-terminated response",
  async (outcome) => {
    const ref = {
      sessionId: "tool-progress",
      sessionKey: "agent:main:tool-progress",
      runId: "reused-run",
    };
    const modelCall = { ...ref, callId: "request", provider: "mock", model: "mock" };
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-10-08T20:02:20Z");
    vi.setSystemTime(startedAt);
    startDiagnosticRunActivityTracking();
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    const replaceOwner = () => {
      closeDiagnosticEmbeddedRunOwner(owner);
      const replacement = createDiagnosticEmbeddedRunOwner(ref);
      markDiagnosticEmbeddedRunStarted({ ...ref, owner: replacement });
    };
    // Tools are built before the diagnostic owner is registered in real attempts.
    const source: AnyAgentTool = {
      name: "read",
      label: "Read",
      description: "Read synthetic content",
      parameters: Type.Object({}),
      execute: async () => {
        if (outcome === "retired-during-execution") {
          replaceOwner();
        }
        return {
          content: [{ type: "text", text: "synthetic content" }],
          details: { status: outcome },
        };
      },
    };
    const tool = wrapToolWithBeforeToolCallHook(source, ref);
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    for (const callId of ["first", "second"]) {
      emitCoreModelRequestStartedDiagnosticEvent({ ...modelCall, callId }, owner.generation);
    }
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    const baselineNow = startedAt + 659_000;
    expect(
      getDiagnosticSessionActivitySnapshot(ref, baselineNow).repeatedRequestNoProgressAgeMs,
    ).toBeDefined();

    // Replay the tool execution at the issue's observed time, then let the
    // enclosing response end with length immediately after.
    vi.setSystemTime(startedAt + 583_000);
    await tool.execute("read-call", {});
    if (outcome === "retired-before-delivery") {
      replaceOwner();
    }
    createModelObserver({ streamContext: {}, capturePromptStats: false }).observeFinalResult(
      modelCall,
      Date.now(),
      {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "toolCall", id: "read-call", name: "read", arguments: {}, async: true }],
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    // Advance to the issue's abort instant so the evidence age crosses the
    // production abort boundary and the watchdog's final decision is exercised.
    const abortNow = startedAt + 659_000;
    const snapshot = getDiagnosticSessionActivitySnapshot(ref, abortNow);
    const stalled = isRepeatedModelRequestStalled(snapshot, STUCK_SESSION_ABORT_MS);
    const attention = classifySessionAttention({
      state: "processing",
      queueDepth: 0,
      activity: snapshot,
      staleMs: STUCK_SESSION_ABORT_MS,
      stuckSessionAbortMs: STUCK_SESSION_ABORT_MS,
    });
    if (outcome === "completed") {
      expect(snapshot.repeatedRequestNoProgressAgeMs).toBeUndefined();
      // Successful execution cleared stagnation evidence for its live owner, so
      // the watchdog does not classify the run as repeated-request stalled even
      // at the abort boundary.
      expect(stalled).toBe(false);
      expect(attention).not.toMatchObject({
        eventType: "session.stalled",
        reason: "repeated_model_requests_without_progress",
      });
    } else {
      expect(snapshot.repeatedRequestNoProgressAgeMs).toBeDefined();
      // Failed, blocked, and retired-owner completions preserve recovery
      // evidence, so the watchdog's final decision still cancels the run.
      expect(stalled).toBe(true);
      expect(attention).toMatchObject({
        eventType: "session.stalled",
        reason: "repeated_model_requests_without_progress",
      });
    }
  },
);
