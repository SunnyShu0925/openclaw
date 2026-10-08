import { Type } from "@sinclair/typebox";
import { afterEach, expect, it } from "vitest";
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
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { createModelObserver } from "./embedded-agent-runner/run/attempt.model-diagnostic-observation.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(() => {
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
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs).toBeDefined();

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
    await waitForDiagnosticEventsDrained();
    const snapshot = getDiagnosticSessionActivitySnapshot(ref);
    if (outcome === "completed") {
      expect(snapshot.repeatedRequestNoProgressAgeMs).toBeUndefined();
    } else {
      expect(snapshot.repeatedRequestNoProgressAgeMs).toBeDefined();
    }
  },
);
