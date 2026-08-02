/** Focused tests for durable assistant-transcript repair across turns and session rotation. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { SessionEntry } from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntries,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { loadManifestModelCatalog } from "../model-catalog.js";
import type { persistCliTurnTranscript } from "./attempt-execution.js";
import type { runAgentAttempt } from "./attempt-execution.runtime.js";

type ProviderModelNormalizationParams = { provider: string; context: { modelId: string } };
type LoadManifestModelCatalogParams = Parameters<typeof loadManifestModelCatalog>[0];
type RunAgentAttempt = typeof runAgentAttempt;
type PersistCliTurnTranscript = typeof persistCliTurnTranscript;
type CliCompactionParams = {
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
};

const state = vi.hoisted(() => ({
  cfg: undefined as OpenClawConfig | undefined,
  workspaceDir: undefined as string | undefined,
  agentDir: undefined as string | undefined,
  runAgentAttemptMock: vi.fn<RunAgentAttempt>(),
  loadManifestModelCatalogMock: vi.fn((_params: LoadManifestModelCatalogParams) => []),
  normalizeProviderModelIdWithRuntimeMock: vi.fn(
    (_params: ProviderModelNormalizationParams) => undefined,
  ),
  runCliTurnCompactionLifecycleMock: vi.fn(
    async (params: CliCompactionParams) => params.sessionEntry,
  ),
  deliverAgentCommandResultMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  persistCliTurnTranscriptMock: vi.fn(),
  persistCliTurnTranscriptReal: undefined as PersistCliTurnTranscript | undefined,
  deliveryFreshEntries: [] as Array<SessionEntry | undefined>,
}));

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: () => state.cfg,
  readConfigFileSnapshotForWrite: async () => ({ snapshot: { valid: false } }),
}));

vi.mock("../agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => ({
    loadedRaw: state.cfg,
    sourceConfig: state.cfg,
    cfg: state.cfg,
  }),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: () => false,
  resolvePluginMetadataSnapshot: () => ({ plugins: [] }),
}));

vi.mock("../agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  return {
    ...actual,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentIds: () => ["main"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => state.agentDir ?? "/tmp/openclaw-agent",
    resolveDefaultAgentId: () => "main",
    resolveEffectiveModelFallbacks: () => undefined,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => state.workspaceDir ?? "/tmp/openclaw-workspace",
  };
});

vi.mock("../model-catalog.js", () => ({
  loadManifestModelCatalog: (params: LoadManifestModelCatalogParams) =>
    state.loadManifestModelCatalogMock(params),
}));

vi.mock("../model-catalog.runtime.js", () => ({
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
  })),
}));

vi.mock("../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) => state.normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("../workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("../auth-profiles/store.js")>(
    "../auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => ({ profiles: {} })),
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ enabled: false, reason: "test" }),
}));

vi.mock("../../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: () => ({
    shouldRefresh: true,
    snapshot: {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    },
  }),
}));

vi.mock("../exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));

vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("./attempt-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./attempt-execution.runtime.js")>(
    "./attempt-execution.runtime.js",
  );
  return {
    ...actual,
    runAgentAttempt: (...args: Parameters<RunAgentAttempt>) => state.runAgentAttemptMock(...args),
    persistCliTurnTranscript: (...args: Parameters<typeof actual.persistCliTurnTranscript>) => {
      state.persistCliTurnTranscriptReal = actual.persistCliTurnTranscript;
      if (state.persistCliTurnTranscriptMock) {
        return state.persistCliTurnTranscriptMock(...args);
      }
      return actual.persistCliTurnTranscript(...args);
    },
  };
});

vi.mock("./cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: (params: CliCompactionParams) =>
    state.runCliTurnCompactionLifecycleMock(params),
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: (...args: Parameters<typeof actual.emitAgentEvent>) => {
      state.emitAgentEventMock(...args);
      return actual.emitAgentEvent(...args);
    },
  };
});

vi.mock("./delivery.runtime.js", () => ({
  deliverAgentCommandResult: (params: unknown) => state.deliverAgentCommandResultMock(params),
}));

let agentCommand: typeof import("../agent-command.js").agentCommand;

beforeAll(async () => {
  agentCommand = (await import("../agent-command.js")).agentCommand;
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.loadManifestModelCatalogMock.mockReturnValue([]);
  state.normalizeProviderModelIdWithRuntimeMock.mockImplementation(() => undefined);
  state.runCliTurnCompactionLifecycleMock.mockImplementation(
    async (params: CliCompactionParams) => params.sessionEntry,
  );
  state.persistCliTurnTranscriptMock.mockImplementation(
    async (...args: Parameters<PersistCliTurnTranscript>) =>
      state.persistCliTurnTranscriptReal?.(...args),
  );
  state.deliveryFreshEntries = [];
  state.deliverAgentCommandResultMock.mockImplementation(
    async (params: {
      resolveFreshSessionEntryForDelivery?: () => Promise<SessionEntry | undefined>;
    }) => {
      state.deliveryFreshEntries.push(await params.resolveFreshSessionEntryForDelivery?.());
      return { deliverySucceeded: true };
    },
  );
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repair-e2e-"));
  state.workspaceDir = path.join(tmpDir, "workspace");
  state.agentDir = path.join(tmpDir, "agent");
  await fs.mkdir(state.workspaceDir, { recursive: true });
  await fs.mkdir(state.agentDir, { recursive: true });
  state.cfg = {
    session: {
      store: path.join(tmpDir, "sessions.json"),
    },
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.5": {},
        },
      },
    },
  } as OpenClawConfig;
});

afterEach(async () => {
  const storePath = state.cfg?.session?.store;
  state.cfg = undefined;
  state.workspaceDir = undefined;
  state.agentDir = undefined;
  if (storePath) {
    await fs.rm(path.dirname(storePath), { recursive: true, force: true });
  }
});

function makeResult(params: {
  sessionId: string;
  sessionFile?: string;
  text: string;
  compactionCount?: number;
  runner?: "cli" | "embedded";
  payloads?: EmbeddedAgentRunResult["payloads"];
}): EmbeddedAgentRunResult {
  return {
    payloads: params.payloads ?? [{ text: params.text }],
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: params.runner ?? "embedded",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.5",
      },
      finalAssistantVisibleText: params.text,
      agentMeta: {
        sessionId: params.sessionId,
        ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
        provider: "openai",
        model: "gpt-5.5",
        ...(params.compactionCount ? { compactionCount: params.compactionCount } : {}),
      },
    },
  };
}

async function readSessionMessages(params: {
  agentId: string;
  sessionId: string;
  storePath: string;
}) {
  return (await loadTranscriptEvents(params))
    .filter(
      (entry): entry is { message: unknown; type: "message" } =>
        typeof entry === "object" &&
        entry !== null &&
        "message" in entry &&
        "type" in entry &&
        entry.type === "message",
    )
    .map((entry) => entry.message);
}

function requireStorePath(): string {
  const storePath = state.cfg?.session?.store;
  if (!storePath) {
    throw new Error("missing test session store path");
  }
  return storePath;
}

function findStoredSessionEntry(sessionKey: string): SessionEntry | undefined {
  return listSessionEntries({ storePath: requireStorePath() }).find(
    (candidate) => candidate.sessionKey === sessionKey,
  )?.entry;
}

describe("assistant transcript repair", () => {
  it("records a durable transcript-repair marker when transcript persistence fails after delivery", async () => {
    const sessionId = "transcript-write-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "delivered reply that failed transcript persistence";
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text, runner: "cli" }));
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );

    const result = await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingTranscriptRepair).toEqual([
      expect.objectContaining({
        version: 1,
        kind: "assistant-turn-repair",
        text,
        sessionId,
        sessionKey,
        agentId: "main",
      }),
    ]);
    // Normal delivery-marker cleanup must not be affected by the failed write.
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
  });

  it("re-appends the missing assistant turn and clears the repair record on the next turn", async () => {
    const sessionId = "transcript-repair-consumed";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply that must be recovered into the transcript";
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text, runner: "cli" }));
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );

    await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toEqual([
      expect.objectContaining({ text }),
    ]);

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "second turn reply", runner: "cli" }),
    );
    await agentCommand({
      message: "second prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    const entryAfterRepair = findStoredSessionEntry(sessionKey);
    expect(entryAfterRepair?.pendingTranscriptRepair).toBeUndefined();
    const transcriptMessages = await readSessionMessages({
      agentId: "main",
      sessionId,
      storePath: requireStorePath(),
    });
    expect(transcriptMessages).toContainEqual(expect.objectContaining({ role: "assistant" }));
    expect(transcriptMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([expect.objectContaining({ type: "text", text })]),
      }),
    );
  });

  it("keeps both delivered finals across consecutive transcript persistence failures", async () => {
    const sessionId = "transcript-backlog-consecutive-failures";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const firstText = "first delivered reply";
    const secondText = "second delivered reply";
    let persistFailuresRemaining = 0;
    state.persistCliTurnTranscriptMock.mockImplementation(
      async (...args: Parameters<PersistCliTurnTranscript>) => {
        if (persistFailuresRemaining > 0) {
          persistFailuresRemaining -= 1;
          throw new Error("simulated transcript table corruption");
        }
        return state.persistCliTurnTranscriptReal?.(...args);
      },
    );
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: firstText, runner: "cli" }),
    );
    persistFailuresRemaining = 1;
    await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: secondText, runner: "cli" }),
    );
    rotateAgentEventLifecycleGeneration();
    // Turn 2: the repair retry attempt AND the current-turn append both fail,
    // so the backlog must retain both delivered finals.
    persistFailuresRemaining = 2;
    await agentCommand({
      message: "second prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    const storedEntry = findStoredSessionEntry(sessionKey);
    const backlog = storedEntry?.pendingTranscriptRepair;
    expect(backlog).toHaveLength(2);
    expect(backlog?.[0]).toMatchObject({ text: firstText });
    expect(backlog?.[1]).toMatchObject({ text: secondText });

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "third turn reply", runner: "cli" }),
    );
    await agentCommand({
      message: "third prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
    const transcriptMessages = await readSessionMessages({
      agentId: "main",
      sessionId,
      storePath: requireStorePath(),
    });
    expect(transcriptMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: firstText }),
        ]),
      }),
    );
    expect(transcriptMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: secondText }),
        ]),
      }),
    );
  });

  it("retains distinct turns that deliver identical reply text across consecutive failures", async () => {
    const sessionId = "transcript-backlog-identical-text";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const sameText = "OK";
    let persistFailuresRemaining = 0;
    state.persistCliTurnTranscriptMock.mockImplementation(
      async (...args: Parameters<PersistCliTurnTranscript>) => {
        if (persistFailuresRemaining > 0) {
          persistFailuresRemaining -= 1;
          throw new Error("simulated transcript table corruption");
        }
        return state.persistCliTurnTranscriptReal?.(...args);
      },
    );

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: sameText, runner: "cli" }),
    );
    persistFailuresRemaining = 1;
    await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    // A real run gets a fresh lifecycle generation per turn; emulate that so
    // each failed turn owns a distinct repair record despite identical text.
    rotateAgentEventLifecycleGeneration();
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: sameText, runner: "cli" }),
    );
    persistFailuresRemaining = 2;
    await agentCommand({
      message: "second prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    const backlog = findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair;
    expect(backlog).toHaveLength(2);
    expect(backlog?.[0]).toMatchObject({ text: sameText });
    expect(backlog?.[1]).toMatchObject({ text: sameText });
    expect(backlog?.[0]?.turnId).not.toBe(backlog?.[1]?.turnId);

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "third turn reply", runner: "cli" }),
    );
    await agentCommand({
      message: "third prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
  });

  it("does not queue a repair for a final owned by another transcript writer", async () => {
    const sessionId = "transcript-owner-boundary";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "runtime-owned assistant final";
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId,
        text,
        runner: "cli",
        payloads: [setReplyPayloadMetadata({ text }, { assistantTranscriptOwned: true })],
      }),
    );
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );

    const result = await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
  });

  it("re-appends a missing turn whose text matches an earlier persisted assistant message", async () => {
    const sessionId = "transcript-repair-equal-tail";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const sameText = "OK";
    let persistFailuresRemaining = 0;
    state.persistCliTurnTranscriptMock.mockImplementation(
      async (...args: Parameters<PersistCliTurnTranscript>) => {
        if (persistFailuresRemaining > 0) {
          persistFailuresRemaining -= 1;
          throw new Error("simulated transcript table corruption");
        }
        return state.persistCliTurnTranscriptReal?.(...args);
      },
    );

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: sameText, runner: "cli" }),
    );
    await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    rotateAgentEventLifecycleGeneration();
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: sameText, runner: "cli" }),
    );
    persistFailuresRemaining = 1;
    await agentCommand({
      message: "second prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });
    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toHaveLength(1);

    rotateAgentEventLifecycleGeneration();
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "third turn reply", runner: "cli" }),
    );
    await agentCommand({
      message: "third prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
    const transcriptMessages = (await readSessionMessages({
      agentId: "main",
      sessionId,
      storePath: requireStorePath(),
    })) as Array<{
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    const assistantTexts = transcriptMessages
      .filter((message) => message?.role === "assistant")
      .map((message) => {
        const content = message?.content;
        return Array.isArray(content)
          ? content
              .filter((part) => part?.type === "text")
              .map((part) => part.text)
              .join("")
          : "";
      });
    expect(assistantTexts.filter((text) => text === sameText)).toHaveLength(2);
  });

  it("recovers a repair record across session rotation onto the successor transcript", async () => {
    const predecessorSessionId = "rotation-predecessor";
    const successorSessionId = "rotation-successor";
    const sessionKey = `agent:main:explicit:${predecessorSessionId}`;
    const missingText = "delivered reply lost before rotation";
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId: predecessorSessionId, text: missingText, runner: "cli" }),
    );
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );

    await agentCommand({
      message: "first prompt",
      sessionId: predecessorSessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });
    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toEqual([
      expect.objectContaining({ sessionId: predecessorSessionId, text: missingText }),
    ]);

    // The next run rotates the same session key to a successor session id
    // (compaction rollover). The repair pass on this turn must migrate the
    // predecessor-scoped record to the successor instead of retaining an
    // unreachable record forever.
    const rotatedSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: successorSessionId,
      storePath: requireStorePath(),
    });
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: successorSessionId,
        sessionFile: rotatedSessionFile,
        text: "second turn reply",
        runner: "cli",
        compactionCount: 1,
      }),
    );
    await agentCommand({
      message: "second prompt",
      sessionId: predecessorSessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    const entryAfterRotation = findStoredSessionEntry(sessionKey);
    expect(entryAfterRotation?.sessionId).toBe(successorSessionId);
    expect(entryAfterRotation?.pendingTranscriptRepair).toBeUndefined();
    const successorMessages = await readSessionMessages({
      agentId: "main",
      sessionId: successorSessionId,
      storePath: requireStorePath(),
    });
    expect(successorMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: missingText }),
        ]),
      }),
    );
  });
});
