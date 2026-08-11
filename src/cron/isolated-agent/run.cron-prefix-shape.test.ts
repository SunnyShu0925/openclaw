// Regression: cron agentTurn user-message prefix must not start with `[cron:`
// (lowercase). DeepSeek's API edge deprioritizes requests whose first user
// message starts with `[cron:` (case-sensitive, anchored), stalling scheduled
// turns under load. The prefix uses `[Cron:` (capital C); the cron-prompt
// recognizers match case-insensitively to keep reading legacy `[cron:` transcripts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "patrol-job",
    name: "patrol",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "run the scheduled patrol" },
    ...overrides,
  } as never;
}

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "run the scheduled patrol",
    sessionKey: "cron:patrol-job",
  };
}

function expectEmbeddedRunPrompt(): string {
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  const runParams = runEmbeddedAgentMock.mock.calls[0]?.[0] as
    | { prompt?: unknown; finalizePromptForResolvedTools?: unknown }
    | undefined;
  const prompt = runParams?.prompt;
  if (typeof prompt !== "string") {
    throw new Error("expected run prompt to be a string");
  }
  return prompt;
}

describe("runCronIsolatedAgentTurn cron prefix shape", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("does not prefix the agentTurn user message with lowercase `[cron:`", async () => {
    await runCronIsolatedAgentTurn(makeParams());
    const prompt = expectEmbeddedRunPrompt();
    // DeepSeek deprioritization trigger is `^\[cron:` (case-sensitive, anchored).
    expect(prompt.startsWith("[cron:")).toBe(false);
  });

  it("prefixes the agentTurn user message with `[Cron:<jobId> <jobName>]`", async () => {
    await runCronIsolatedAgentTurn(makeParams());
    const prompt = expectEmbeddedRunPrompt();
    expect(prompt.startsWith("[Cron:patrol-job patrol]")).toBe(true);
  });
});
