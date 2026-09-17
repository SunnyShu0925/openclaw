import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
import { runSessionCompactionIfNeeded as runSessionCompactionIfNeededRaw } from "./agent-runner-memory.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";

const { compactEmbeddedAgentSessionMock, incrementCompactionCountMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
  incrementCompactionCountMock: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: vi.fn(),
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
}));
vi.mock("./session-updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-updates.js")>()),
  incrementCompactionCount: incrementCompactionCountMock,
}));
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  refreshQueuedFollowupSession: vi.fn(),
}));

type PreflightCompactionTestParams = Parameters<typeof runSessionCompactionIfNeededRaw>[0] & {
  modelContextTokens?: number;
};

async function runSessionCompactionIfNeeded(params: PreflightCompactionTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runSessionCompactionIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({
      cfg: runParams.cfg,
      followupRun: runParams.followupRun,
      defaultModel: runParams.defaultModel,
      contextTokens: modelContextTokens,
    }),
  });
}

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

describe("runSessionCompactionIfNeeded context-engine idle skip (#148189)", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-idle-skip-"));
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    incrementCompactionCountMock.mockReset().mockResolvedValue(1);
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("skips required preflight when a context engine returns a benign idle result", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "no claimable pending summary nodes",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    await writeTestSessionStore(
      path.join(rootDir, "sessions.json"),
      "agent:main:main",
      sessionEntry,
    );

    const entry = await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      abortSignal: new AbortController().signal,
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("fails required preflight when a context engine returns a failed idle result", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no claimable pending summary nodes",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    await writeTestSessionStore(
      path.join(rootDir, "sessions.json"),
      "agent:main:main",
      sessionEntry,
    );

    await expect(
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100,
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        sessionKey: "agent:main:main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Preflight compaction required but failed: no claimable pending summary nodes",
    );
  });
});
