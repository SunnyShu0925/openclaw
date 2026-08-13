// Canonical-form guard for the isolated-cron agentTurn envelope (see #123041).
// DeepSeek's API edge deprioritizes requests whose user message carries the
// `[cron:` bracket grammar (case- and position-independent). The producer must
// emit a plain-text envelope so the bracket grammar never reaches the model;
// recognizers still read legacy `[cron:`/`[Cron:` transcripts from history.
// This guard would have caught a regression to bracket grammar before it ships.
import "../isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelThinkingDefault from "../../agents/model-thinking-default.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  runCronTurn,
  withTempHome,
} from "../isolated-agent.turn-test-helpers.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

setupRunCronIsolatedAgentTurnSuite();

// Matches the `[cron:` bracket grammar in any case, at any position. A freshly
// generated cron user message must NEVER match this — that is the canonical
// form this guard enforces.
const CRON_BRACKET_GRAMMAR_RE = /\[[cC][rR][oO][nN]:/;

function lastEmbeddedAgentPrompt(): string {
  const calls = runEmbeddedAgentMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected runEmbeddedAgent call");
  }
  const value = call[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected runEmbeddedAgent call payload");
  }
  const prompt = (value as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string") {
    throw new Error("expected runEmbeddedAgent prompt to be a string");
  }
  return prompt;
}

describe("runCronIsolatedAgentTurn cron envelope canonical form", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
    vi.spyOn(modelThinkingDefault, "resolveThinkingDefault").mockReturnValue("off");
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockClear();
  });

  it("does not emit the `[cron:` bracket grammar in the agentTurn user message (any case, any position)", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, { jobPayload: DEFAULT_AGENT_TURN_PAYLOAD });
    });

    const prompt = lastEmbeddedAgentPrompt();
    // Canonical-form invariant: the bracket grammar must never appear in new
    // output. This would have caught the `[cron:` -> `[Cron:` case-only change.
    expect(CRON_BRACKET_GRAMMAR_RE.test(prompt)).toBe(false);
  });

  it("prefixes the agentTurn user message with the plain-text `cron job <id> <name>:` envelope", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, { jobPayload: DEFAULT_AGENT_TURN_PAYLOAD });
    });

    const prompt = lastEmbeddedAgentPrompt();
    const firstLine = prompt.split("\n")[0] ?? "";
    expect(firstLine.startsWith("cron job job-1 job-1:")).toBe(true);
    expect(firstLine).toContain("do it");
  });
});
