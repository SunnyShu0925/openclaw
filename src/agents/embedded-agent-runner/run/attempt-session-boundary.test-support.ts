import { vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";

export function createActiveSession(messages: AgentMessage[] = []) {
  const reset = vi.fn();
  const convertToLlm = vi.fn((input: AgentMessage[]) => input as never);
  const activeSession = {
    agent: {
      reset,
      state: { messages },
      convertToLlm,
    },
  } as unknown as Pick<AgentSession, "agent">;
  return { activeSession, convertToLlm, reset };
}

export function createSessionManager(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof guardSessionManager> {
  return {
    getHeader: () => ({ version: 3 }),
    getLeafEntry: () => undefined,
    getSessionTarget: () => undefined,
    getSessionId: () => "session-boundary",
    // prepareEmbeddedAttemptSessionBoundary reloads the persisted transcript
    // before orphan repair. These fixtures project a static view, so the
    // reload is a no-op that preserves the cached leaf.
    reloadPersistedTranscriptAsync: async () => {},
    ...overrides,
  } as unknown as ReturnType<typeof guardSessionManager>;
}
