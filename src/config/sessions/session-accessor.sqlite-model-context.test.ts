// Model-context transcript reads must honor reset boundaries so a reset drops
// the previous generation from agent input instead of re-attaching an
// oversized transcript to the new session (#123334).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  loadModelContextTranscriptEventsSync,
  persistSessionTranscriptTurn,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite model-context reset window", () => {
  let stateDir: string;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-model-context-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "model-context-test",
      sessionKey: "agent:main:model-context-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  const messageEventIds = (events: readonly unknown[]): Array<string | undefined> =>
    events
      .filter(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          !Array.isArray(event) &&
          (event as { type?: unknown }).type === "message",
      )
      .map((event) => (event as { id?: unknown }).id as string | undefined);

  it("keeps the full transcript when the session has never been reset", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "u1", parentId: null, message: { role: "user", content: "first" } },
        { eventId: "a1", parentId: "u1", message: { role: "assistant", content: "second" } },
      ],
      touchSessionEntry: false,
    });

    expect(messageEventIds(loadModelContextTranscriptEventsSync(scope))).toEqual(["u1", "a1"]);
  });

  it("excludes the pre-reset generation from agent input after a reset", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "old-assistant",
          parentId: "old",
          message: { role: "assistant", content: "old answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "old-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "new turn" },
        },
      ],
      touchSessionEntry: false,
    });

    const ids = messageEventIds(loadModelContextTranscriptEventsSync(scope));
    expect(ids).not.toContain("old");
    expect(ids).not.toContain("old-assistant");
    expect(ids).toContain("post-reset");
  });

  it("keeps only the bounded replay tail referenced by the reset boundary", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept question" },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-user",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "new turn" },
        },
      ],
      touchSessionEntry: false,
    });

    expect(messageEventIds(loadModelContextTranscriptEventsSync(scope))).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);
  });

  it("uses only the latest reset boundary after repeated resets", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "old", parentId: null, message: { role: "user", content: "old" } }],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-1",
      parentId: "old",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "mid",
          parentId: "reset-1",
          message: { role: "user", content: "mid turn" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-2",
      parentId: "mid",
      timestamp: "2026-07-22T00:01:00.000Z",
      reason: "new",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset-2",
          parentId: "reset-2",
          message: { role: "user", content: "fresh turn" },
        },
      ],
      touchSessionEntry: false,
    });

    expect(messageEventIds(loadModelContextTranscriptEventsSync(scope))).toEqual(["post-reset-2"]);
  });

  it("keeps compaction-session history intact when no reset boundary exists", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "u1", parentId: null, message: { role: "user", content: "first" } },
        { eventId: "a1", parentId: "u1", message: { role: "assistant", content: "second" } },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compaction-1",
      parentId: "a1",
      timestamp: "2026-07-22T00:00:00.000Z",
      summary: "compacted",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    });

    expect(messageEventIds(loadModelContextTranscriptEventsSync(scope))).toEqual(["u1", "a1"]);
  });

  it("keeps runtime markers and tool events inside the kept replay tail after a reset", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept question" },
        },
        {
          eventId: "kept-tool",
          parentId: "kept-user",
          message: { role: "toolResult", content: "hidden tool result" },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-tool",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "thinking_level_change",
      id: "thinking-change",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      thinkingLevel: "high",
    });
    await appendTranscriptEvent(scope, {
      type: "model_change",
      id: "model-change",
      parentId: "thinking-change",
      timestamp: "2026-07-22T00:00:00.000Z",
      modelId: "gpt-5.5",
      provider: "openai",
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compaction-1",
      parentId: "model-change",
      timestamp: "2026-07-22T00:00:00.000Z",
      summary: "compacted",
      firstKeptEntryId: "kept-user",
      tokensBefore: 10,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "compaction-1",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "new turn" },
        },
      ],
      touchSessionEntry: false,
    });

    const loaded = loadModelContextTranscriptEventsSync(scope);
    expect((loaded[0] as { type?: unknown }).type).toBe("session");
    const eventIds = loaded
      .filter((event) => (event as { type?: unknown }).type !== "session")
      .map((event) => (event as { id?: unknown }).id);
    expect(eventIds).toEqual([
      "kept-user",
      "kept-tool",
      "kept-assistant",
      "thinking-change",
      "model-change",
      "compaction-1",
      "reset-boundary",
      "post-reset",
    ]);
    expect(messageEventIds(loaded)).toEqual([
      "kept-user",
      "kept-tool",
      "kept-assistant",
      "post-reset",
    ]);
  });
});
