// Regression guard: the doctor media-persistence migration must apply the
// filesystem journal-mode policy before any ownership/version metadata read,
// so an existing WAL database on a virtiofs/9p-backed volume cannot touch its
// -wal/-shm sidecars during the migration (issue #120549).
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];
const PREVIOUS_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION - 1;

type FixtureEvent = Record<string, unknown>;

function createEvent(params: {
  id: string;
  message: Record<string, unknown>;
  parentId: string | null;
  timestamp: number;
}): FixtureEvent {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: params.timestamp,
    message: params.message,
  };
}

function createLegacyDatabaseFixture(params: {
  agentId?: string;
  env: NodeJS.ProcessEnv;
  eventsBySession: Record<string, FixtureEvent[]>;
}): string {
  const agentId = params.agentId ?? "main";
  const opened = openOpenClawAgentDatabase({ agentId, env: params.env });
  const databasePath = opened.path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(`PRAGMA user_version = ${PREVIOUS_VERSION};`);
    database
      .prepare(
        "UPDATE schema_meta SET schema_version = ?, app_version = ? WHERE meta_key = 'primary'",
      )
      .run(PREVIOUS_VERSION, "legacy-test");
    for (const [sessionId, events] of Object.entries(params.eventsBySession)) {
      const sessionKey = `agent:${agentId}:${sessionId}`;
      const firstTimestamp = Number(events[0]?.timestamp ?? 1);
      database
        .prepare(
          "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,?,?)",
        )
        .run(sessionKey, sessionId, "{}", firstTimestamp);
      database
        .prepare(
          "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,?,?)",
        )
        .run(sessionId, sessionKey, firstTimestamp, firstTimestamp);
      database
        .prepare(
          "INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at) VALUES(?,?,?)",
        )
        .run(sessionId, `generation-${sessionId}`, firstTimestamp);
      events.forEach((event, seq) => {
        const createdAt = Number(event.timestamp ?? firstTimestamp) + 100;
        database
          .prepare(
            "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)",
          )
          .run(sessionId, seq, JSON.stringify(event), createdAt);
        database
          .prepare(
            "INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,parent_id,message_idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            sessionId,
            String(event.id),
            seq,
            String(event.type),
            typeof event.parentId === "string" ? event.parentId : null,
            (event.message as { idempotencyKey?: string }).idempotencyKey ?? null,
            createdAt,
          );
      });
      reconcileSessionTranscriptIndexInTransaction(database, sessionId);
    }
  } finally {
    database.close();
  }
  registerOpenClawAgentDatabase({
    agentId,
    env: params.env,
    path: databasePath,
    schemaVersion: PREVIOUS_VERSION,
  });
  return databasePath;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
});

describe("legacy media persistence migration journal-mode ordering", () => {
  it("applies rollback journaling before ownership reads on a virtiofs-backed volume (issue #120549 ordering)", () => {
    // Doctor invokes migrateLegacyMediaPersistence, which re-opens each agent
    // database and reads ownership/version metadata before its first migration
    // write. On a virtiofs/9p-backed volume the journal-mode policy must demote
    // the database to rollback (DELETE) before that ownership read so an existing
    // WAL database cannot touch its -wal/-shm sidecars during the migration.
    const stateDir = makeTempDir(tempDirs, "media-persistence-virtiofs-ordering-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    // Seed a legacy (PREVIOUS_VERSION) database carrying legacy MediaPaths
    // fields — the exact shape the doctor migration rewrites.
    const agentDbPath = createLegacyDatabaseFixture({
      agentId: "main",
      env,
      eventsBySession: {
        "ordering-session": [
          createEvent({
            id: "event-ordering",
            parentId: null,
            timestamp: 1000,
            message: {
              role: "assistant",
              content: "ordering",
              MediaPaths: ["/media/ordering.png"],
              MediaTypes: ["image/png"],
            },
          }),
        ],
      },
    });
    // Drop sidecars left by the fixture's raw writes so the test asserts
    // sidecars created (or not) by the migration opener alone.
    fs.rmSync(`${agentDbPath}-wal`, { force: true });
    fs.rmSync(`${agentDbPath}-shm`, { force: true });
    // Classify the temp dir as virtiofs: statfs returns FUSE_SUPER_MAGIC
    // (shared with ordinary FUSE, so statfs cannot distinguish virtiofs) and
    // the mountinfo fallback returns a virtiofs entry rooted at the temp dir.
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      type: 0x65735546,
      bsize: 1024,
      blocks: 1,
      bfree: 1,
      bavail: 1,
      files: 0,
      frsize: 1024,
      ffree: 0,
    });
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    const realReadFileSync =
      readFileSyncSpy.mock.original ?? (fs.readFileSync as typeof fs.readFileSync);
    readFileSyncSpy.mockImplementation((filePath, ...rest) => {
      if (filePath === "/proc/self/mountinfo") {
        return `${42} 12 0:41 / ${stateDir} rw,relatime - virtiofs /path/on/host rw\n`;
      }
      return realReadFileSync(filePath, ...(rest as []));
    });

    const result = migrateLegacyMediaPersistence({ env });
    expect(
      result.changes.length,
      `changes=${JSON.stringify(result.changes)} warnings=${JSON.stringify(result.warnings)}`,
    ).toBeGreaterThan(0);
    // Assert the post-migration state IMMEDIATELY, without routing back through
    // openOpenClawAgentDatabase: that standard opener also applies
    // applySqliteJournalModePolicy, which would erase any WAL evidence the
    // migration left behind and mask a pre-fix regression. A raw DatabaseSync
    // open reads PRAGMA journal_mode without changing it, so the assertion
    // observes the exact mode the migration settled on.
    expect(fs.existsSync(`${agentDbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${agentDbPath}-shm`)).toBe(false);
    const { DatabaseSync } = requireNodeSqlite();
    const probe = new DatabaseSync(agentDbPath, { readOnly: true });
    try {
      const mode = probe.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
      expect(mode.journal_mode).toBe("delete");
    } finally {
      probe.close();
    }
  });
});
