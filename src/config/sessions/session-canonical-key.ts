import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  hasSqliteSessionOwnerColumns,
  projectSqliteSessionOwner,
} from "./session-accessor.sqlite-owner-projection.js";
import { sessionEntryMetadataJson } from "./session-accessor.sqlite-status.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import {
  normalizeStoreSessionKey,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { SessionEntry } from "./types.js";

const SESSION_CANONICAL_KEY_REPAIR_COMMAND = "openclaw doctor --fix";
type CanonicalSessionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "session_key_contract" | "session_nodes" | "session_windows"
>;
const validatedDatabases = new WeakMap<DatabaseSync, string>();
const mainKeyReaders = new WeakMap<DatabaseSync, () => { main_key: string } | undefined>();
// Path-based cache for fresh read-only connections that share no DatabaseSync object.
// One fingerprint per path; overwriting on change keeps the entry count bounded.
const validatedDatabasePaths = new Map<string, string>();

function resolveDatabasePath(db: DatabaseSync): string {
  // SAFETY: PRAGMA database_list always returns { seq, name, file }.
  const row = db.prepare("PRAGMA database_list").get() as { file?: unknown }; // sqlite-allow-raw -- Read-only file path for cache identity; no row data accessed.
  // In-memory databases (empty path) cannot share validation across connections.
  return typeof row.file === "string" ? row.file : "";
}

function resolveDatabaseFingerprint(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    // Include the WAL sidecar so committed-but-uncheckpointed writes invalidate the cache.
    // WAL commits change the -wal file's mtime/size even when the main file is untouched.
    let fingerprint = `${stat.mtimeMs}:${stat.size}`;
    try {
      const walStat = fs.statSync(`${filePath}-wal`);
      fingerprint += `:${walStat.mtimeMs}:${walStat.size}`;
    } catch {
      // No WAL file (fresh DB or fully checkpointed) — main file fingerprint is sufficient.
    }
    return fingerprint;
  } catch {
    // File deleted or renamed mid-run — treat as uncacheable so the caller revalidates.
    return undefined;
  }
}

type CanonicalSessionMetadata = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

export type ValidatedSessionMetadata = CanonicalSessionMetadata & { dataVersion: number };

class SessionCanonicalKeyMigrationRequiredError extends Error {
  readonly code = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";

  constructor(detail: string) {
    super(`${detail}; stop the Gateway and run ${SESSION_CANONICAL_KEY_REPAIR_COMMAND}`);
    this.name = "SessionCanonicalKeyMigrationRequiredError";
  }
}

function isCanonicalSessionKey(sessionKey: string): boolean {
  const trimmed = sessionKey.trim();
  if (!trimmed || sessionKey !== trimmed) {
    return false;
  }
  if (normalizeStoreSessionKey(sessionKey) !== sessionKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(trimmed);
  return (
    trimmed === "global" ||
    trimmed === "unknown" ||
    (parsed !== null && trimmed.startsWith(`agent:${parsed.agentId}:`))
  );
}

export function assertCanonicalSessionKeyWrite(sessionKey: string, expectedAgentId?: string): void {
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !isCanonicalSessionKey(sessionKey) ||
    (expectedAgentId && parsed && parsed.agentId !== normalizeAgentId(expectedAgentId))
  ) {
    throw canonicalSessionKeyMigrationRequiredError(
      `refusing non-canonical session key write ${sessionKey}`,
    );
  }
}

function readCanonicalSessionMainKey(database: { db: DatabaseSync }): string {
  let read = mainKeyReaders.get(database.db);
  if (!read) {
    const query = prepareSqliteQueryTakeFirstSync<void, { main_key: string }>(database.db, () =>
      getNodeSqliteKysely<CanonicalSessionDatabase>(database.db)
        .selectFrom("session_key_contract")
        .select("main_key")
        .where("id", "=", 1),
    );
    read = () => query();
    mainKeyReaders.set(database.db, read);
  }
  return normalizeMainKey(read()?.main_key);
}

function assertCanonicalSessionMainKeyWrite(sessionKey: string, mainKey: string): void {
  if (parseAgentSessionKey(sessionKey)?.rest === "main" && mainKey !== "main") {
    throw canonicalSessionKeyMigrationRequiredError(
      `refusing non-canonical session key write ${sessionKey}`,
    );
  }
}

export function assertCanonicalSessionEntryLineageWrite(
  database: { db: DatabaseSync },
  entry: SessionEntry,
): void {
  const sessionKeys = [
    entry.parentSessionKey,
    entry.spawnedBy,
    entry.forkSource?.sessionKey,
  ].filter((sessionKey): sessionKey is string => sessionKey !== undefined);
  if (sessionKeys.length === 0) {
    return;
  }
  const mainKey = readCanonicalSessionMainKey(database);
  for (const sessionKey of sessionKeys) {
    assertCanonicalSessionKeyWrite(sessionKey);
    assertCanonicalSessionMainKeyWrite(sessionKey, mainKey);
  }
}

export function assertCanonicalSessionKeyWriteMatchesDatabase(
  database: { agentId: string; db: DatabaseSync },
  sessionKey: string,
): void {
  // Exact SQLite locators are shared stores; the outer resolved scope already enforces
  // logical agent ownership before this database-level shape check.
  assertCanonicalSessionKeyWrite(sessionKey);
  assertCanonicalSessionMainKeyWrite(sessionKey, readCanonicalSessionMainKey(database));
}

export function canonicalSessionKeyMigrationRequiredError(
  detail: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(detail);
}

export function scanCanonicalSqliteSessionEntries(
  database: { agentId: string; db: DatabaseSync },
  visit?: (summary: { entry: SessionEntry; sessionKey: string }) => void,
  mainKey?: string,
  metadata?: CanonicalSessionMetadata,
): number {
  // Row validation belongs to this connection and its stored main-key policy.
  // Untracked row edits still require a fresh connection; Doctor owns live repair.
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const storedMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  const canonicalMainKey = normalizeMainKey(mainKey ?? storedMainKey);
  let count = 0;
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .leftJoin("session_windows as retained_window", (join) =>
        join
          .onRef("retained_window.session_id", "=", "session_nodes.current_session_id")
          .onRef("retained_window.session_key", "=", "session_nodes.session_key"),
      )
      .select([
        "session_nodes.session_key",
        "session_nodes.current_session_id",
        "session_nodes.entry_valid",
        "session_nodes.fork_source_session_key",
        "session_nodes.parent_session_key",
        "session_nodes.spawned_by",
        "retained_window.session_id as retained_window_id",
      ])
      // Key validation needs metadata; Doctor visitors still own complete saved entries.
      .select(visit ? "session_nodes.entry_json" : sessionEntryMetadataJson)
      .$if(Boolean(metadata), (query) => query.select("session_nodes.updated_at"))
      .$if(Boolean(metadata) && hasSqliteSessionOwnerColumns(database.db), (query) =>
        query.select([
          "session_nodes.owner_actor_type",
          "session_nodes.owner_actor_id",
          "session_nodes.owner_assigned_by_type",
          "session_nodes.owner_assigned_by_id",
          "session_nodes.owner_assigned_at",
        ]),
      )
      .orderBy("session_nodes.session_key"),
  )) {
    // Retained windows have no entry, but their keys remain part of a listing snapshot.
    metadata?.keys.push(row.session_key);
    if (
      row.entry_json === "{}" &&
      row.entry_valid === -1 &&
      row.retained_window_id === row.current_session_id
    ) {
      continue;
    }
    const record =
      row.entry_valid === 1
        ? parseSqliteSessionEntryRecord({
            entry_json: row.entry_json,
            current_session_id: row.current_session_id,
          })
        : null;
    if (!record) {
      throw canonicalSessionKeyMigrationRequiredError(
        `invalid persisted session row requires repair for ${row.session_key}`,
      );
    }
    const entry = projectCanonicalSessionEntryShape(record);
    if (
      (row.parent_session_key ?? undefined) !==
        (entry.parentSessionKey ?? entry.spawnedBy ?? undefined) ||
      (row.spawned_by ?? undefined) !== (entry.spawnedBy ?? undefined) ||
      (row.fork_source_session_key ?? undefined) !== (entry.forkSource?.sessionKey ?? undefined)
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        `invalid persisted session row requires repair for ${row.session_key}`,
      );
    }
    const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(row.session_key, entry);
    if (deliveryCanonicalKey !== row.session_key) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
      );
    }
    const trimmed = row.session_key.trim();
    const parsed = parseAgentSessionKey(trimmed);
    if (
      row.session_key !== trimmed ||
      normalizeStoreSessionKey(trimmed) !== trimmed ||
      (!parsed && trimmed !== "global" && trimmed !== "unknown") ||
      (parsed && parsed.rest === "main" && canonicalMainKey !== "main")
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${trimmed || row.session_key}`,
      );
    }
    for (const lineageKey of [
      row.parent_session_key,
      row.spawned_by,
      row.fork_source_session_key,
    ]) {
      if (!lineageKey) {
        continue;
      }
      const normalized = normalizeStoreSessionKey(lineageKey);
      const lineageParsed = parseAgentSessionKey(normalized);
      if (
        normalized !== lineageKey ||
        (!lineageParsed && normalized !== "global" && normalized !== "unknown") ||
        (lineageParsed?.rest === "main" && canonicalMainKey !== "main")
      ) {
        throw canonicalSessionKeyMigrationRequiredError(
          `non-canonical persisted row resolves to session key ${normalized || lineageKey}`,
        );
      }
    }
    if (metadata && record.updatedAt === row.updated_at) {
      // List decoding also checks the row timestamp and strips SQL-fallback prompt payloads;
      // neither rule belongs to canonical validation or Doctor's complete-entry visitor.
      const { skillsSnapshot: _skills, systemPromptReport: _report, ...listEntry } = entry;
      metadata.entries.set(row.session_key, projectSqliteSessionOwner(listEntry, row));
    }
    visit?.({ entry, sessionKey: row.session_key });
    count += 1;
  }
  validatedDatabases.set(database.db, normalizeMainKey(storedMainKey));
  const cachePath = resolveDatabasePath(database.db);
  if (cachePath) {
    const fingerprint = resolveDatabaseFingerprint(cachePath);
    if (fingerprint) {
      validatedDatabasePaths.set(cachePath, fingerprint);
    }
  }
  return count;
}

export function assertCanonicalSqliteSessionKeysCurrent(
  database: { agentId: string; db: DatabaseSync },
  mainKey?: string,
  collectMetadata = false,
): ValidatedSessionMetadata | undefined {
  const validatedMainKey = validatedDatabases.get(database.db);
  // Another connection can commit a Doctor/startup policy change while this reader stays open.
  if (
    validatedMainKey !== undefined &&
    validatedMainKey === readCanonicalSessionMainKey(database)
  ) {
    return undefined;
  }
  // Fresh read-only connections share no DatabaseSync object; fall back to a
  // path-based fingerprint so an unchanged file reuses validation without re-scanning.
  const cachePath = resolveDatabasePath(database.db);
  if (cachePath) {
    const fingerprint = resolveDatabaseFingerprint(cachePath);
    if (fingerprint && validatedDatabasePaths.get(cachePath) === fingerprint) {
      return undefined;
    }
  }
  const metadata: ValidatedSessionMetadata | undefined = collectMetadata
    ? { dataVersion: readSqliteDataVersion(database.db), entries: new Map(), keys: [] }
    : undefined;
  scanCanonicalSqliteSessionEntries(database, undefined, mainKey, metadata);
  return metadata;
}

export function setCanonicalSqliteSessionMainKey(
  database: { db: DatabaseSync },
  mainKey: string | undefined,
): void {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const currentMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  if (currentMainKey === canonicalMainKey) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_key_contract")
      .values({ id: 1, main_key: canonicalMainKey, updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          main_key: canonicalMainKey,
          updated_at: Date.now(),
        }),
      ),
  );
  validatedDatabases.delete(database.db);
  const cachePath = resolveDatabasePath(database.db);
  if (cachePath) {
    validatedDatabasePaths.delete(cachePath);
  }
}

/** Checks the startup contract without joining the writable database lifecycle. */
export function isCanonicalSqliteSessionMainKeyCurrent(
  options: OpenClawAgentDatabaseOptions,
  mainKey: string | undefined,
): boolean {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
    const schema = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("schema_meta").select("schema_version").where("meta_key", "=", "primary"),
    );
    if (schema?.schema_version !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return false;
    }
    return (
      executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
      )?.main_key === canonicalMainKey
    );
  }, options);
  return result.found && result.value;
}

/** Clears the path-based validation cache so fresh connections revalidate. */
export function clearValidatedDatabasePaths(): void {
  validatedDatabasePaths.clear();
}
