import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry, PendingTranscriptRepairState } from "../../config/sessions/types.js";
/**
 * Durable repair for assistant finals that were delivered to the user but
 * failed to reach the canonical transcript.
 *
 * `persistCliTurnTranscript` failures are intentionally non-fatal for the
 * turn (the reply is still delivered), but the only durable copy of the final
 * used to be the `pendingFinalDelivery` marker — which is cleared after a
 * successful send. These helpers keep a separate `pendingTranscriptRepair`
 * record on the session entry so the missing assistant turn can be re-appended
 * once the transcript writer works again, without conflating transport replay
 * with transcript repair.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { loadAttemptExecutionRuntime } from "./runtime-loaders.js";
import { persistSessionEntry } from "./session-helpers.js";

const log = createSubsystemLogger("agents/assistant-transcript-repair");

type AssistantTranscriptRepairContext = {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  config: OpenClawConfig;
};

/**
 * Persists a best-effort repair record for an assistant final that could not
 * be appended to the transcript. Never throws: a failed repair-record write
 * only degrades back to today's log-and-continue behavior.
 */
export async function persistAssistantTranscriptRepairRecord(params: {
  context: AssistantTranscriptRepairContext;
  replyText: string;
  turnId?: string;
  provider?: string;
  model?: string;
  runOwnedSessionId: string;
}): Promise<void> {
  const { context, replyText, turnId, provider, model, runOwnedSessionId } = params;
  if (!replyText.trim()) {
    return;
  }
  if (!context.sessionStore || context.sessionKey.trim() === "") {
    return;
  }
  const now = Date.now();
  const existing = context.sessionStore[context.sessionKey] ?? context.sessionEntry;
  if (!existing) {
    return;
  }
  const backlog = existing.pendingTranscriptRepair ?? [];
  if (
    turnId &&
    backlog.some(
      (record) =>
        record.sessionKey === context.sessionKey &&
        record.sessionId === context.sessionId &&
        record.turnId === turnId,
    )
  ) {
    return;
  }
  const nextRepair: PendingTranscriptRepairState = {
    version: 1,
    kind: "assistant-turn-repair",
    text: replyText,
    ...(turnId ? { turnId } : {}),
    ...(provider?.trim() ? { provider: provider.trim() } : {}),
    ...(model?.trim() ? { model: model.trim() } : {}),
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
    agentId: context.sessionAgentId,
    ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
    ...(context.storePath ? { storePath: context.storePath } : {}),
    createdAt: now,
  };
  try {
    await persistSessionEntry({
      sessionStore: context.sessionStore,
      sessionKey: context.sessionKey,
      storePath: context.storePath,
      initialEntry: existing,
      entry: { ...existing, pendingTranscriptRepair: [...backlog, nextRepair], updatedAt: now },
      shouldPersist: (current) =>
        current?.sessionId === runOwnedSessionId && current.abortedLastRun !== true,
    });
  } catch (error) {
    log.warn(
      `Failed to persist assistant transcript repair record for ${context.sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}

/**
 * Best-effort re-append of a previously delivered assistant final that never
 * reached the transcript. Clears the repair record on success; on failure it
 * keeps the record for a later attempt and never blocks the current turn.
 */
export async function repairPendingAssistantTranscriptTurn(params: {
  context: AssistantTranscriptRepairContext;
}): Promise<void> {
  const { context } = params;
  if (!context.sessionStore || !context.sessionKey) {
    return;
  }
  const freshEntry =
    context.sessionStore[context.sessionKey] ??
    loadSessionEntryReadOnly({
      storePath: context.storePath,
      sessionKey: context.sessionKey,
      readConsistency: "latest",
      clone: false,
    });
  const backlog = freshEntry?.pendingTranscriptRepair;
  if (!backlog || backlog.length === 0) {
    return;
  }

  const remaining: PendingTranscriptRepairState[] = [];
  for (let index = 0; index < backlog.length; index += 1) {
    const item = backlog[index]!;
    if (freshEntry.sessionId !== item.sessionId) {
      // The transcript target rotated (compaction/session rollover). Keep the
      // record; cross-session writes are out of scope for this repair lane.
      remaining.push(item);
      continue;
    }
    const syntheticResult: EmbeddedAgentRunResult = {
      payloads: [{ text: item.text }],
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: item.text,
        agentMeta: {
          sessionId: item.sessionId,
          provider: item.provider ?? "",
          model: item.model ?? "",
        },
      },
    };
    try {
      const { persistCliTurnTranscript } = await loadAttemptExecutionRuntime();
      const transcriptResult = await persistCliTurnTranscript({
        body: "",
        result: syntheticResult,
        sessionId: item.sessionId,
        sessionKey: item.sessionKey,
        sessionEntry: freshEntry,
        sessionStore: context.sessionStore,
        storePath: item.storePath ?? context.storePath,
        sessionAgentId: item.agentId,
        threadId: item.threadId ?? context.threadId,
        sessionCwd: context.sessionCwd,
        config: context.config,
        // Exact per-turn idempotency (not tail-text gap-fill): a distinct
        // failed turn must be re-appended even when an earlier persisted
        // assistant message has identical text.
        embeddedAssistantGapFill: false,
        assistantIdempotencyKey: `transcript-repair:${item.sessionId}:${item.turnId ?? item.createdAt}`,
        skipAssistantTurn: false,
        skipUserTurn: true,
      });
      if (transcriptResult.kind === "session-rebound") {
        remaining.push(item);
        continue;
      }
      const current = context.sessionStore[context.sessionKey];
      if (current?.sessionId !== item.sessionId) {
        remaining.push(item);
        continue;
      }
      log.info(
        `Re-appended missing assistant transcript turn for ${context.sessionKey} after storage recovery`,
      );
    } catch (error) {
      remaining.push({
        ...item,
        lastAttemptAt: Date.now(),
        attemptCount: (item.attemptCount ?? 0) + 1,
      });
      remaining.push(...backlog.slice(index + 1));
      log.warn(
        `Assistant transcript repair retry failed for ${context.sessionKey}: ${formatErrorMessage(error)}`,
      );
      break;
    }
  }

  const current = context.sessionStore[context.sessionKey];
  if (!current) {
    return;
  }
  try {
    await persistSessionEntry({
      sessionStore: context.sessionStore,
      sessionKey: context.sessionKey,
      storePath: context.storePath,
      initialEntry: current,
      entry: {
        ...current,
        pendingTranscriptRepair: remaining.length > 0 ? remaining : undefined,
        updatedAt: Date.now(),
      },
    });
  } catch {
    // A failed backlog cleanup must not throw; the next turn retries.
  }
}
