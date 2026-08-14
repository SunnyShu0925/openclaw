import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  LatestTranscriptAssistantMessage,
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
  SessionTranscriptEventRow,
  SessionTranscriptStats,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { coerceSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export type SqliteTranscriptSnapshotRow = {
  eventJson: string;
  seq: number;
};

export type SqliteTranscriptStorageRow = SqliteTranscriptSnapshotRow & {
  createdAt: number;
};

/** Loads raw transcript events from the additive SQLite transcript store. */
export async function loadTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return loadTranscriptEventsSync(scope);
}

/** Loads raw transcript events synchronously from the additive SQLite transcript store. */
export function loadTranscriptEventsSync(scope: SessionTranscriptReadScope): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      return loadTranscriptEventsFromDatabase(database, resolved.sessionId, fence?.beforeRawSeq);
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript fenced read",
    },
  );
}

/** Latest reset boundary index in storage order, or -1 when absent. */
function findLatestResetBoundaryIndex(events: readonly TranscriptEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type =
      events[index] && typeof events[index] === "object" && !Array.isArray(events[index])
        ? (events[index] as { type?: unknown }).type
        : undefined;
    if (type === "reset") {
      return index;
    }
  }
  return -1;
}

function readResetBoundaryFirstKeptEntryId(boundary: TranscriptEvent): string | undefined {
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
    return undefined;
  }
  const firstKept = (boundary as { firstKeptEntryId?: unknown }).firstKeptEntryId;
  return typeof firstKept === "string" && firstKept.trim() ? firstKept : undefined;
}

function findEventIndexById(
  events: readonly TranscriptEvent[],
  fromIndex: number,
  id: string,
): number {
  for (let index = fromIndex; index >= 0; index -= 1) {
    const event = events[index];
    if (event && typeof event === "object" && !Array.isArray(event)) {
      if ((event as { id?: unknown }).id === id) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Loads the model-context transcript window for a session.
 *
 * History readers already project a logical message window after the latest
 * reset boundary (see session-accessor.sqlite-reset-window.ts). The agent
 * context loader must apply the same boundary so a reset drops the previous
 * generation from model input instead of re-attaching an oversized transcript
 * (#123334). Raw rows are never deleted: the window keeps the session header,
 * the full kept replay tail referenced by the reset boundary (firstKeptEntryId)
 * — including intermediate tool events and runtime markers — the boundary event
 * itself, and every event after it. Sessions without a reset boundary are
 * returned intact.
 */
export function loadModelContextTranscriptEventsSync(
  scope: SessionTranscriptReadScope,
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      const events = loadTranscriptEventsFromDatabase(
        database,
        resolved.sessionId,
        fence?.beforeRawSeq,
      );
      const resetBoundaryIndex = findLatestResetBoundaryIndex(events);
      if (resetBoundaryIndex < 0) {
        return events;
      }
      const firstKeptEntryId = readResetBoundaryFirstKeptEntryId(events[resetBoundaryIndex]);
      const windowStart = firstKeptEntryId
        ? findEventIndexById(events, resetBoundaryIndex - 1, firstKeptEntryId)
        : resetBoundaryIndex;
      const sliceStart = windowStart < 0 ? resetBoundaryIndex : windowStart;
      const windowed = events.slice(sliceStart);
      if (sliceStart > 0) {
        const header = events.find(
          (event) =>
            event !== null &&
            typeof event === "object" &&
            !Array.isArray(event) &&
            (event as { type?: unknown }).type === "session",
        );
        if (header) {
          windowed.unshift(header);
        }
      }
      return windowed;
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript model-context read",
    },
  );
}

/** Loads only the first transcript row for header metadata hot paths. */
export function loadTranscriptHeaderSync(scope: SessionTranscriptReadScope): unknown {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", resolved.sessionId)
      .orderBy("seq", "asc")
      .limit(1),
  );
  return row ? (JSON.parse(row.event_json) as TranscriptEvent) : undefined;
}

/** Loads a bounded newest tail in storage order for hot-path accounting. */
export function loadTranscriptTailEventsSync(
  scope: SessionTranscriptReadScope,
  maxEvents: number,
): TranscriptEvent[] {
  const limit = Number.isFinite(maxEvents) ? Math.max(0, Math.floor(maxEvents)) : 0;
  if (limit === 0) {
    return [];
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", resolved.sessionId)
      .orderBy("seq", "desc")
      .limit(limit),
  )
    .rows.toReversed()
    .map((row) => JSON.parse(row.event_json) as TranscriptEvent);
}

/** Loads additive transcript rows after one durable sequence checkpoint. */
export function loadTranscriptEventRowsAfterSeqSync(
  scope: SessionTranscriptReadScope,
  afterSeq: number,
  throughSeq?: number,
): SessionTranscriptEventRow[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  let query = db
    .selectFrom("transcript_events")
    .select(["event_json", "seq"])
    .where("session_id", "=", resolved.sessionId)
    .where("seq", ">", afterSeq);
  if (throughSeq !== undefined) {
    query = query.where("seq", "<=", throughSeq);
  }
  return executeSqliteQuerySync(database.db, query.orderBy("seq", "asc")).rows.map((row) => ({
    event: JSON.parse(row.event_json) as TranscriptEvent,
    seq: coerceSqliteNumber(row.seq),
  }));
}

/** Reads one checkpoint row so incremental consumers can reject transcript rewrites. */
export function readTranscriptEventAtSeqSync(
  scope: SessionTranscriptReadScope,
  seq: number,
): SessionTranscriptEventRow | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", resolved.sessionId)
      .where("seq", "=", seq),
  );
  return row
    ? {
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: coerceSqliteNumber(row.seq),
      }
    : undefined;
}

export function loadTranscriptEventsFromDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
  beforeEventSeq?: number,
): TranscriptEvent[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
}

export function readTranscriptSnapshot(
  database: OpenClawAgentDatabase,
  sessionId: string,
): { events: TranscriptEvent[]; rows: SqliteTranscriptSnapshotRow[] } {
  const rows = readTranscriptEventRows(database, sessionId);
  return {
    events: rows.map((row) => JSON.parse(row.eventJson) as TranscriptEvent),
    rows,
  };
}

/** Reads transcript rows without decoding payloads for snapshot comparison. */
export function readTranscriptEventRows(
  database: OpenClawAgentDatabase,
  sessionId: string,
): SqliteTranscriptSnapshotRow[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => ({
    eventJson: row.event_json,
    seq: coerceSqliteNumber(row.seq),
  }));
}

/** Reads exact transcript storage rows for guarded doctor rewrites. */
export function readTranscriptStorageRows(
  database: OpenClawAgentDatabase,
  sessionId: string,
): SqliteTranscriptStorageRow[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["created_at", "event_json", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => ({
    createdAt: coerceSqliteNumber(row.created_at),
    eventJson: row.event_json,
    seq: coerceSqliteNumber(row.seq),
  }));
}

function sqliteTranscriptJsonlByteSize() {
  return /* kysely-allow-raw: JSONL size includes event bytes plus newline separators. */ sql<number>`COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0)
    + CASE WHEN COUNT(*) > 0 THEN COUNT(*) - 1 ELSE 0 END`.as("size_bytes");
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readTranscriptStatsSync(scope: SessionTranscriptReadScope): SessionTranscriptStats {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn.count<number>("seq").as("event_count"),
        eb.fn.max<number>("seq").as("max_seq"),
        sqliteTranscriptJsonlByteSize(),
      ])
      .where("session_id", "=", resolved.sessionId),
  );
  const session = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["transcript_observed_at", "transcript_updated_at"])
      .where("session_id", "=", resolved.sessionId),
  );
  return {
    eventCount: row?.event_count ?? 0,
    ...(session?.transcript_updated_at !== null && session?.transcript_updated_at !== undefined
      ? { lastMutationAtMs: session.transcript_updated_at }
      : {}),
    ...(session?.transcript_observed_at !== null && session?.transcript_observed_at !== undefined
      ? { lastObservedMutationAtMs: session.transcript_observed_at }
      : {}),
    maxSeq: row?.max_seq ?? 0,
    sizeBytes: row?.size_bytes ?? 0,
  };
}

export function readTranscriptEventJsonSetInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("transcript_events").select("event_json").where("session_id", "=", sessionId),
  ).rows;
  return new Set(rows.map((row) => row.event_json));
}

/** Reads the latest visible assistant text from SQLite transcript rows in reverse order. */
export function loadLatestAssistantText(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantText | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getSessionKysely(database.db);
      const beforeEventSeq = resolveSqliteSessionTranscriptReadFence({
        database,
        ...resolved,
      })?.beforeRawSeq;
      const rows = iterateSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events as te")
          .innerJoin("transcript_event_identities as ti", (join) =>
            join.onRef("ti.session_id", "=", "te.session_id").onRef("ti.seq", "=", "te.seq"),
          )
          .select("te.event_json as event_json")
          .where("te.session_id", "=", resolved.sessionId)
          .where("ti.event_type", "=", "message")
          .$if(beforeEventSeq !== undefined, (query) => query.where("ti.seq", "<", beforeEventSeq!))
          .orderBy("ti.seq", "desc"),
      );
      for (const row of rows) {
        const latest = parseLatestAssistantMessageEvent(row.event_json, options);
        if (!latest) {
          continue;
        }
        const text = parseLatestAssistantText(latest);
        if (text) {
          return text;
        }
      }
      return undefined;
    },
    {
      databaseLabel: database.path,
      operationLabel: "latest assistant fenced read",
    },
  );
}

function parseLatestAssistantText(
  latest: LatestTranscriptAssistantMessage,
): LatestTranscriptAssistantText | undefined {
  const message = latest.message as { timestamp?: unknown };
  const text = extractAssistantPhaseText(latest.message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(latest.id ? { id: latest.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function parseLatestAssistantMessageEvent(
  raw: string,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: { model?: unknown; provider?: unknown; role?: unknown; timestamp?: unknown };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}

/** Finds the newest transcript record accepted by the matcher without parsing older rows. */
export async function findTranscriptEvent(
  scope: SessionTranscriptReadScope,
  match: (event: TranscriptEvent) => boolean,
): Promise<{ event: TranscriptEvent } | undefined> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return findTranscriptEventInDatabase(database, resolved.sessionId, match);
}

export function findTranscriptEventInDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc"),
  ).rows;
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as TranscriptEvent;
      if (match(event)) {
        return { event };
      }
    } catch {
      // Malformed rows are skipped, matching transcript index tolerance.
    }
  }
  return undefined;
}

export function readTranscriptEventMessage(
  event: TranscriptEvent,
): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const message = (event as { message?: unknown }).message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

export function readTranscriptEventId(event: TranscriptEvent): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}
