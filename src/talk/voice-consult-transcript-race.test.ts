import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareEmbeddedAttemptSessionBoundary } from "../agents/embedded-agent-runner/run/attempt-session-prepare.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../agents/sessions/index.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  appendRelayVoiceTranscript,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
} from "./client-voice-session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const agentId = "main";
const CONSULT_REPLY = "Two meetings tomorrow.";

function readMessageTexts(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): string[] {
  return loadTranscriptEventsSync(scope).flatMap((event) => {
    const message = (event as { message?: { content?: unknown } } | null)?.message;
    const content = message?.content;
    if (typeof content === "string") {
      return [content];
    }
    if (!Array.isArray(content)) {
      return [];
    }
    return content.flatMap((block) =>
      block && typeof block === "object" && "text" in block
        ? [String((block as { text: unknown }).text)]
        : [],
    );
  });
}

async function prepareConsultTurn(label: string) {
  const dir = tempDirs.make(`openclaw-${label}-`);
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = `agent:${agentId}:${label}`;
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "earlier question", timestamp: 1 });
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "what is on the calendar tomorrow?",
    timestamp: 2,
  });
  const anchor = admission.anchor;
  if (!anchor) {
    throw new Error("missing current-turn anchor");
  }
  const appendConsultReply = () =>
    runWithSessionTranscriptReadFence({ ...anchor, logicalTurnId: label, role: "user" }, () =>
      SessionManager.openBounded(scope, {
        cwd: dir,
        maxBytes: 8192,
        maxEvents: 16,
      }).appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: CONSULT_REPLY }],
          timestamp: 5,
        }),
      ),
    );
  return { appendConsultReply, scope, sessionKey, storePath };
}

beforeEach(() => {
  envSnapshot.restore();
});

afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  envSnapshot.restore();
});

// openclaw#150204 family: the live call keeps transcribing while the consult runs.
it("keeps the voice transcript from failing an in-flight agent consult", async () => {
  const { appendConsultReply, scope, sessionKey, storePath } =
    await prepareConsultTurn("voice-consult-relay");
  const voiceSessionId = createOrResumeClientVoiceSession({
    agentId,
    sessionKey,
    origin: "relay",
    provider: "realtime",
  });
  const target = {
    agentId,
    sessionKey,
    sessionTarget: { sessionKey, storePath },
    voiceSessionId,
  };
  await appendRelayVoiceTranscript({
    ...target,
    entryId: "utterance-1",
    role: "user",
    text: "what is on the calendar tomorrow?",
  });
  await appendRelayVoiceTranscript({
    ...target,
    entryId: "filler-1",
    role: "assistant",
    text: "I'll check that request.",
  });

  expect(() => appendConsultReply()).not.toThrow();

  expect(readMessageTexts(scope)).toEqual([
    "earlier question",
    "what is on the calendar tomorrow?",
    "what is on the calendar tomorrow?",
    "I'll check that request.",
    CONSULT_REPLY,
  ]);
});

// The exemption keys on the marker the voice writer stamps, not on the kind alone.
it.each([
  { label: "no-channel", provenance: { kind: "realtime_voice" } },
  {
    label: "foreign-channel",
    provenance: { kind: "realtime_voice", sourceChannel: "discord" },
  },
  {
    label: "foreign-kind",
    provenance: { kind: "typed_chat", sourceChannel: "talk" },
  },
])(
  "still rejects a consult reply superseded by a $label user row",
  async ({ label, provenance }) => {
    const { appendConsultReply, scope } = await prepareConsultTurn(`voice-consult-${label}`);
    await appendTranscriptMessage(scope, {
      eventId: `forged:${label}`,
      message: {
        role: "user",
        content: [{ type: "text", text: "different question" }],
        timestamp: 3,
        provenance,
      },
      now: 3,
    });

    expect(() => appendConsultReply()).toThrow("SQLite transcript changed while preparing rewrite");
    expect(readMessageTexts(scope)).not.toContain(CONSULT_REPLY);
  },
);

it("regression: session manager sees stale leaf until reload (#162907)", async () => {
  const dir = tempDirs.make("openclaw-stale-orphan-");
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = "agent:main:stale-orphan";
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };

  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "orphan question", timestamp: 1 });

  const manager = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 8192, maxEvents: 16 });
  expect((manager.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  await appendTranscriptMessage(scope, {
    eventId: "voice-finalized",
    message: makeAgentAssistantMessage({
      content: [{ type: "text", text: "voice reply" }],
      timestamp: 2,
    }),
    now: 2,
  });

  expect((manager.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  await manager.reloadPersistedTranscriptAsync();
  expect((manager.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe(
    "assistant",
  );
});

it("regression: boundary reloads stale transcript before orphan repair (#162907)", async () => {
  const dir = tempDirs.make("openclaw-boundary-reload-");
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = "agent:main:boundary-reload";
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };

  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "orphan question", timestamp: 1 });

  const guarded = guardSessionManager(
    SessionManager.openBounded(scope, { cwd: dir, maxBytes: 8192, maxEvents: 16 }),
    { runId: "boundary-reload" },
  );

  // Simulate finalized Talk speech advancing the durable transcript after
  // the session manager was loaded — the cached leaf is still "user".
  expect((guarded.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  await appendTranscriptMessage(scope, {
    eventId: "voice-finalized",
    message: makeAgentAssistantMessage({
      content: [{ type: "text", text: "voice reply" }],
      timestamp: 2,
    }),
    now: 2,
  });

  // Cached view is stale — still sees the user leaf.
  expect((guarded.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  const activeSession = {
    agent: {
      reset: vi.fn(),
      state: { messages: [] as AgentMessage[] },
      convertToLlm: vi.fn((input: AgentMessage[]) => input as never),
    },
  } as unknown as Pick<AgentSession, "agent">;

  // The boundary reloads the persisted transcript before computing the
  // orphan repair plan. After reload the leaf is "assistant", so no orphan
  // user-turn repair is attempted — preventing a stale mutation-version write.
  const result = await prepareEmbeddedAttemptSessionBoundary({
    abortSignal: undefined,
    activeSession,
    attempt: {
      sessionId,
      prompt: "consult request",
    },
    getUserTranscriptContexts: () => undefined,
    isRawModelRun: false,
    preparedUserTurnMessage: undefined,
    sessionManager: guarded,
    setActiveSessionSystemPrompt: vi.fn(),
  });

  expect(result.orphanRepair).toBeUndefined();
  expect((guarded.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe(
    "assistant",
  );
});
