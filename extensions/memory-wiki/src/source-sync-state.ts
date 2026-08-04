// Memory Wiki plugin module implements source sync state behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { createWikiPageFilename, extractHumanNotesBlock } from "./markdown.js";

export type MemoryWikiImportedSourceGroup = "bridge" | "unsafe-local";

type MemoryWikiImportedSourceStateEntry = {
  group: MemoryWikiImportedSourceGroup;
  pagePath: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
};

type MemoryWikiImportedSourceState = {
  version: 1;
  entries: Record<string, MemoryWikiImportedSourceStateEntry>;
};

type MemoryWikiSourceSyncStateChanges = {
  upsertKeys: Set<string>;
  deleteKeys: Set<string>;
};

type MemoryWikiSourceSyncStateWritePlan = {
  upsertKeys: string[];
  deleteKeys: string[];
};

type MemoryWikiSourceSyncStateStore = {
  read: (vaultRoot: string) => Promise<MemoryWikiImportedSourceState>;
  write: (
    vaultRoot: string,
    state: MemoryWikiImportedSourceState,
    plan?: MemoryWikiSourceSyncStateWritePlan,
  ) => Promise<void>;
};

type MemoryWikiSourceSyncStateRecord = MemoryWikiImportedSourceStateEntry & {
  vaultRootKey: string;
  syncKey: string;
};

export const MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE = "source-sync";
export const MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES = 20_000;
const MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES = 64 * 1024;
const MAX_MEMORY_WIKI_SOURCE_PAGE_SCAN_BYTES = 32 * 1024 * 1024;

const EMPTY_STATE: MemoryWikiImportedSourceState = {
  version: 1,
  entries: {},
};

let configuredSourceSyncStore: MemoryWikiSourceSyncStateStore | undefined;
const memorySourceSyncStateByVault = new Map<string, MemoryWikiImportedSourceState>();
const sourceSyncStateChanges = new WeakMap<
  MemoryWikiImportedSourceState,
  MemoryWikiSourceSyncStateChanges
>();

export function resolveMemoryWikiSourceSyncStatePath(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
}

function cloneSourceSyncState(state: MemoryWikiImportedSourceState): MemoryWikiImportedSourceState {
  return {
    version: 1,
    entries: Object.fromEntries(
      Object.entries(state.entries).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function isResolvedEntryKey(key: string): boolean {
  return key.startsWith("bridge\0") || key.startsWith("unsafe-local\0");
}

function normalizeSourceSyncState(value: unknown): MemoryWikiImportedSourceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_STATE;
  }
  const parsed = value as Partial<MemoryWikiImportedSourceState>;
  if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
    return EMPTY_STATE;
  }
  const entries: Record<string, MemoryWikiImportedSourceStateEntry> = {};
  for (const [key, entry] of Object.entries(parsed.entries)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      (entry.group !== "bridge" && entry.group !== "unsafe-local") ||
      typeof entry.pagePath !== "string" ||
      typeof entry.sourcePath !== "string" ||
      typeof entry.sourceUpdatedAtMs !== "number" ||
      typeof entry.sourceSize !== "number" ||
      typeof entry.renderFingerprint !== "string"
    ) {
      continue;
    }
    // Legacy JSON keys are bare syncKeys; already-resolved composite keys are
    // preserved so normalization is idempotent during migration merges.
    entries[isResolvedEntryKey(key) ? key : resolveEntryKey(entry.group, key)] = {
      group: entry.group,
      pagePath: entry.pagePath,
      sourcePath: entry.sourcePath,
      sourceUpdatedAtMs: entry.sourceUpdatedAtMs,
      sourceSize: entry.sourceSize,
      renderFingerprint: entry.renderFingerprint,
    };
  }
  return { version: 1, entries };
}

function resolveVaultRootKey(vaultRoot: string): string {
  return createHash("sha256").update(path.resolve(vaultRoot), "utf8").digest("hex").slice(0, 32);
}

// The same physical source can be imported through both the bridge and
// unsafe-local modes, each generating its own page. Ownership must therefore be
// scoped by (group, syncKey); a bare-syncKey key would let the second import
// overwrite the first mode's ownership row and orphan its page (issue #118370).
function resolveStateEntryKey(
  vaultRootKey: string,
  group: MemoryWikiImportedSourceGroup,
  syncKey: string,
): string {
  return createHash("sha256").update(`${vaultRootKey}\0${group}\0${syncKey}`, "utf8").digest("hex");
}

// Pre-#118370 rows were stored under a bare `(vaultRootKey, syncKey)` key with
// no group segment. Used to physically reclaim legacy rows alongside their
// canonical replacements (incremental prune, full-write reclamation, Doctor
// migration). A bare key shares no prefix with either group-scoped canonical
// key, so deleting it cannot touch a canonical row.
function resolveBareStateEntryKey(vaultRootKey: string, syncKey: string): string {
  return createHash("sha256").update(`${vaultRootKey}\0${syncKey}`, "utf8").digest("hex");
}

// In-memory entries are keyed by `${group}\0${syncKey}`. NUL is safe as a
// separator because a filesystem path can never contain NUL.
function resolveEntryKey(group: MemoryWikiImportedSourceGroup, syncKey: string): string {
  return `${group}\0${syncKey}`;
}

function resolveEntryGroup(entryKey: string): MemoryWikiImportedSourceGroup {
  const sep = entryKey.indexOf("\0");
  return sep === -1 ? "bridge" : (entryKey.slice(0, sep) as MemoryWikiImportedSourceGroup);
}

export function resolveEntrySyncKey(entryKey: string): string {
  const sep = entryKey.indexOf("\0");
  return sep === -1 ? entryKey : entryKey.slice(sep + 1);
}

function createMemoryFallbackStateStore(): MemoryWikiSourceSyncStateStore {
  return {
    async read(vaultRoot) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      return cloneSourceSyncState(memorySourceSyncStateByVault.get(vaultRootKey) ?? EMPTY_STATE);
    },
    async write(vaultRoot, state) {
      assertSourceSyncStateWithinLimit(state);
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      memorySourceSyncStateByVault.set(vaultRootKey, cloneSourceSyncState(state));
    },
  };
}

function assertSourceSyncStateWithinLimit(state: MemoryWikiImportedSourceState): void {
  const count = Object.keys(state.entries).length;
  if (count > MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES) {
    throw new Error(
      `Memory Wiki source sync state exceeds SQLite entry limit (${count}/${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES})`,
    );
  }
}

export function assertMemoryWikiSourceSyncStateCapacity(params: {
  state: MemoryWikiImportedSourceState;
  group: MemoryWikiImportedSourceGroup;
  incomingCount: number;
}): void {
  const retainedOtherGroupCount = Object.values(params.state.entries).filter(
    (entry) => entry.group !== params.group,
  ).length;
  const projectedCount = retainedOtherGroupCount + params.incomingCount;
  if (projectedCount > MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES) {
    throw new Error(
      `Memory Wiki source sync state exceeds SQLite entry limit (${projectedCount}/${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES})`,
    );
  }
}

export function createMemoryWikiSourceSyncStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): MemoryWikiSourceSyncStateStore {
  const openStore = () =>
    openKeyedStore<MemoryWikiSourceSyncStateRecord>({
      namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });

  return {
    async read(vaultRoot) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const entries: MemoryWikiImportedSourceState["entries"] = {};
      for (const row of await openStore().entries()) {
        const value = row.value;
        // Validate persisted record fields before projecting them, mirroring
        // `normalizeSourceSyncState` — a malformed row (e.g. non-string
        // pagePath from a corrupted or partially-written entry) must be
        // skipped, not projected into the in-memory state where compile/lint
        // would throw on a non-string field.
        if (
          value.vaultRootKey !== vaultRootKey ||
          typeof value.syncKey !== "string" ||
          (value.group !== "bridge" && value.group !== "unsafe-local") ||
          typeof value.pagePath !== "string" ||
          typeof value.sourcePath !== "string" ||
          typeof value.sourceUpdatedAtMs !== "number" ||
          typeof value.sourceSize !== "number" ||
          typeof value.renderFingerprint !== "string"
        ) {
          continue;
        }
        // Legacy rows predating #118370 were stored under a bare-syncKey key but
        // still carry `group`, so re-keying by (group, syncKey) is backward compatible.
        entries[resolveEntryKey(value.group, value.syncKey)] = {
          group: value.group,
          pagePath: value.pagePath,
          sourcePath: value.sourcePath,
          sourceUpdatedAtMs: value.sourceUpdatedAtMs,
          sourceSize: value.sourceSize,
          renderFingerprint: value.renderFingerprint,
        };
      }
      return { version: 1, entries };
    },
    async write(vaultRoot, state, plan) {
      assertSourceSyncStateWithinLimit(state);
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const store = openStore();
      if (plan) {
        // Runtime incremental writes are canonical-only: the plan addresses
        // composite (group, syncKey) keys, and `read` already re-keys legacy
        // bare-key rows on the way out. Physically rewriting legacy rows to
        // canonical keys is a capacity-sensitive operation (the namespace is
        // `reject-new` at 20,000 entries) and is owned by the Memory Wiki Doctor
        // migration `memory-wiki-source-sync-bare-key-to-group-scoped`, which
        // runs at the established upgrade boundary instead of on every sync.
        // See `migrateMemoryWikiSourceSyncBareKeys` and issue #118370.
        for (const entryKey of plan.deleteKeys) {
          const syncKey = resolveEntrySyncKey(entryKey);
          const entryGroup = resolveEntryGroup(entryKey);
          // Delete the canonical group-scoped row...
          await store.delete(resolveStateEntryKey(vaultRootKey, entryGroup, syncKey));
          // ...and the pre-#118370 bare-key row for the same syncKey — but only
          // when its group matches. A bare key is `sha256(vaultRootKey, syncKey)`
          // with no group segment, so bridge and unsafe-local share the same
          // physical bare key for an identical source. Deleting it unconditionally
          // during a bridge prune would remove an unsafe-local legacy ownership
          // row (or vice versa), orphaning the other mode's page and Notes.
          // `deleteIf` with a group predicate avoids that; when `deleteIf` is
          // unavailable the bare row is left for the Doctor migration to reclaim.
          const bareKey = resolveBareStateEntryKey(vaultRootKey, syncKey);
          if (store.deleteIf) {
            await store.deleteIf(bareKey, (current) => current.group === entryGroup);
          }
        }
        for (const entryKey of plan.upsertKeys) {
          const entry = state.entries[entryKey];
          if (!entry) {
            throw new Error(`Missing tracked Memory Wiki source sync entry: ${entryKey}`);
          }
          const syncKey = resolveEntrySyncKey(entryKey);
          const canonicalKey = resolveStateEntryKey(vaultRootKey, entry.group, syncKey);
          const record = { ...entry, vaultRootKey, syncKey };
          // Capacity-safe canonical registration. Under normal conditions the
          // legacy bare-key row for this syncKey is left untouched for the
          // Doctor migration to reclaim — `read` re-keys it transparently, so
          // behavior is correct before the Doctor runs. But at the `reject-new`
          // cap (20,000 entries) an active source update has already written its
          // page before this state sync runs; if the canonical key is new and
          // the namespace is physically full of legacy bare rows, `register`
          // throws PLUGIN_STATE_LIMIT_EXCEEDED, leaving the changed page
          // untracked. To recover, reclaim the matching bare-key slot (same
          // syncKey, same group) and retry — this frees one slot without
          // affecting other groups (the bare key is shared across groups for
          // the same source, so the group predicate is essential).
          try {
            await store.register(canonicalKey, record);
          } catch (error) {
            if ((error as { code?: string }).code !== "PLUGIN_STATE_LIMIT_EXCEEDED") {
              throw error;
            }
            const bareKey = resolveBareStateEntryKey(vaultRootKey, syncKey);
            if (store.deleteIf) {
              await store.deleteIf(bareKey, (current) => current.group === entry.group);
            }
            await store.register(canonicalKey, record);
          }
        }
        return;
      }
      const normalized = normalizeSourceSyncState(state);
      const nextKeys = new Set(
        Object.entries(normalized.entries).map(([entryKey, entry]) =>
          resolveStateEntryKey(vaultRootKey, entry.group, resolveEntrySyncKey(entryKey)),
        ),
      );
      // NOTE: this full-write path deletes stale/bare rows before registering
      // replacements. A crash in that gap could orphan a page's ownership row.
      // The keyed-store API exposes only single-key operations (no cross-key
      // atomic relocation), so making this fully crash-safe without temporary
      // cap growth — which would break capacity-bound replacement (see
      // `deletes replaced rows before upserts at the store capacity`) — requires
      // a core-backed atomic relocation primitive that the extension layer
      // cannot provide. Until that primitive exists, the JSON-to-plugin-state
      // Doctor migration is the only caller of this path and runs at a managed
      // upgrade boundary; the runtime sync hot path uses the incremental plan
      // branch above, which is canonical-only and does not delete-then-insert.
      for (const row of await store.entries()) {
        if (row.value.vaultRootKey === vaultRootKey && !nextKeys.has(row.key)) {
          await store.delete(row.key);
        }
      }
      for (const [entryKey, entry] of Object.entries(normalized.entries)) {
        await store.register(
          resolveStateEntryKey(vaultRootKey, entry.group, resolveEntrySyncKey(entryKey)),
          {
            ...entry,
            vaultRootKey,
            syncKey: resolveEntrySyncKey(entryKey),
          },
        );
      }
    },
  };
}

export function configureMemoryWikiSourceSyncStateStore(
  store: MemoryWikiSourceSyncStateStore | undefined,
): void {
  configuredSourceSyncStore = store;
}

function resolveSourceSyncStore(
  store?: MemoryWikiSourceSyncStateStore,
): MemoryWikiSourceSyncStateStore {
  return store ?? configuredSourceSyncStore ?? createMemoryFallbackStateStore();
}

export async function readMemoryWikiSourceSyncState(
  vaultRoot: string,
  store?: MemoryWikiSourceSyncStateStore,
): Promise<MemoryWikiImportedSourceState> {
  const state = await resolveSourceSyncStore(store).read(vaultRoot);
  sourceSyncStateChanges.set(state, { upsertKeys: new Set(), deleteKeys: new Set() });
  return state;
}

export async function readLegacyMemoryWikiSourceSyncState(
  vaultRoot: string,
): Promise<MemoryWikiImportedSourceState> {
  const statePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
  const { value: parsed } = await readJsonFileWithFallback<unknown>(statePath, EMPTY_STATE);
  return normalizeSourceSyncState(parsed);
}

export async function writeMemoryWikiSourceSyncState(
  vaultRoot: string,
  state: MemoryWikiImportedSourceState,
  store?: MemoryWikiSourceSyncStateStore,
): Promise<void> {
  const changes = sourceSyncStateChanges.get(state);
  if (changes && changes.upsertKeys.size === 0 && changes.deleteKeys.size === 0) {
    return;
  }
  const plan = changes
    ? {
        upsertKeys: [...changes.upsertKeys],
        deleteKeys: [...changes.deleteKeys],
      }
    : undefined;
  await resolveSourceSyncStore(store).write(vaultRoot, state, plan);
  changes?.upsertKeys.clear();
  changes?.deleteKeys.clear();
}

export async function shouldSkipImportedSourceWrite(params: {
  vaultRoot: string;
  group: MemoryWikiImportedSourceGroup;
  syncKey: string;
  expectedPagePath: string;
  expectedSourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  state: MemoryWikiImportedSourceState;
}): Promise<boolean> {
  const entry = params.state.entries[resolveEntryKey(params.group, params.syncKey)];
  if (!entry) {
    return false;
  }
  if (
    entry.pagePath !== params.expectedPagePath ||
    entry.sourcePath !== params.expectedSourcePath ||
    entry.sourceUpdatedAtMs !== params.sourceUpdatedAtMs ||
    entry.sourceSize !== params.sourceSize ||
    entry.renderFingerprint !== params.renderFingerprint
  ) {
    return false;
  }
  const pagePath = path.join(params.vaultRoot, params.expectedPagePath);
  return await fs
    .access(pagePath)
    .then(() => true)
    .catch(() => false);
}

function removeImportedSourceStateEntry(
  state: MemoryWikiImportedSourceState,
  entryKey: string,
): void {
  delete state.entries[entryKey];
  const changes = sourceSyncStateChanges.get(state);
  changes?.upsertKeys.delete(entryKey);
  changes?.deleteKeys.add(entryKey);
}

async function readImportedSourcePageForNotes(
  vault: Awaited<ReturnType<typeof fsRoot>>,
  pagePath: string,
): Promise<string> {
  try {
    return await vault.readText(pagePath, {
      maxBytes: MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES,
    });
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "too-large")) {
      throw error;
    }
  }

  // Pin the same safe file while reading only its source header and trailing
  // Notes; large generated source content must not prevent safe pruning.
  const opened = await vault.open(pagePath);
  try {
    const readSlice = async (position: number, length: number): Promise<string> => {
      const buffer = Buffer.alloc(length);
      let totalBytesRead = 0;
      while (totalBytesRead < length) {
        const { bytesRead } = await opened.handle.read(
          buffer,
          totalBytesRead,
          length - totalBytesRead,
          position + totalBytesRead,
        );
        if (bytesRead === 0) {
          throw new Error("Memory Wiki source page changed during bounded Notes recovery");
        }
        totalBytesRead += bytesRead;
      }
      return buffer.toString("utf8");
    };

    const headerBytes = Math.min(MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES, opened.stat.size);
    const header = await readSlice(0, headerBytes);

    const contentFence = /(?:^|\r?\n)## Content\r?\n(`+)[^\r\n]*(?=\r?\n|$)/u.exec(header);
    if (!contentFence) {
      throw new Error("Memory Wiki source content fence is missing from the recovery header");
    }
    const fence = contentFence[1];
    // Scan from the pinned descriptor so the first complete producer-owned
    // boundary wins; a similar fence inside later human Notes cannot qualify.
    const notesBoundary = new RegExp(
      `\\r?\\n${fence}\\r?\\n(?:[\\t ]*\\r?\\n)*## Notes\\r?\\n<!-- openclaw:human:start -->(?=\\r?\\n|$)`,
      "u",
    );
    const decoder = new TextDecoder();
    let pending = "";
    let notes = "";
    let notesBytes = 0;
    let scannedBytes = headerBytes;
    let foundNotesBoundary = false;

    const consume = (text: string): void => {
      if (!text) {
        return;
      }
      let notesText = text;
      if (!foundNotesBoundary) {
        pending += text;
        const boundary = notesBoundary.exec(pending);
        if (!boundary) {
          pending = pending.slice(-MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES);
          return;
        }
        foundNotesBoundary = true;
        notesText = pending.slice(boundary.index);
        pending = "";
      }
      notesBytes += Buffer.byteLength(notesText, "utf8");
      if (headerBytes + notesBytes > MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES) {
        throw new Error("Memory Wiki human Notes exceed the bounded recovery limit");
      }
      notes += notesText;
    };

    consume(header);
    const stream = opened.handle.createReadStream({
      autoClose: false,
      highWaterMark: MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES,
      start: headerBytes,
    });
    for await (const chunk of stream) {
      scannedBytes += chunk.byteLength;
      if (scannedBytes > MAX_MEMORY_WIKI_SOURCE_PAGE_SCAN_BYTES) {
        throw new Error("Memory Wiki source page exceeds the bounded recovery scan limit");
      }
      consume(decoder.decode(chunk, { stream: true }));
    }
    consume(decoder.decode());

    if (!foundNotesBoundary) {
      throw new Error("Memory Wiki source Notes boundary exceeds the bounded recovery limit");
    }

    return `${header}\n${notes}`;
  } finally {
    await opened.handle.close();
  }
}

export async function pruneImportedSourceEntries(params: {
  vaultRoot: string;
  group: MemoryWikiImportedSourceGroup;
  activeKeys: Set<string>;
  state: MemoryWikiImportedSourceState;
}): Promise<number> {
  let removedCount = 0;
  let vault: Awaited<ReturnType<typeof fsRoot>> | undefined;
  for (const [entryKey, entry] of Object.entries(params.state.entries)) {
    // Entries are keyed by (group, syncKey); only prune the active group and
    // only when this exact group no longer tracks the source.
    if (entry.group !== params.group || params.activeKeys.has(resolveEntrySyncKey(entryKey))) {
      continue;
    }
    try {
      vault ??= await fsRoot(params.vaultRoot);
    } catch (error) {
      if (!(error instanceof FsSafeError && error.code === "not-found")) {
        throw error;
      }
      removeImportedSourceStateEntry(params.state, entryKey);
      removedCount += 1;
      continue;
    }
    // Recover durable Notes before removing an imported source page. The root
    // handle applies containment and no-follow checks to each operation.
    let pageContent: string | undefined;
    try {
      pageContent = await readImportedSourcePageForNotes(vault, entry.pagePath);
    } catch (error) {
      if (!(error instanceof FsSafeError && error.code === "not-found")) {
        continue;
      }
    }
    const notesBlock = pageContent === undefined ? null : extractHumanNotesBlock(pageContent);
    if (notesBlock) {
      const salvageStem = entry.pagePath.replace(/\//g, "_");
      const contentHash = createHash("sha256").update(notesBlock).digest("hex").slice(0, 16);
      const salvagePaths = [
        path.join(".salvage", createWikiPageFilename(salvageStem, ".notes.md")),
        path.join(".salvage", createWikiPageFilename(`${salvageStem}.${contentHash}`, ".notes.md")),
      ];
      let notesSalvaged = false;
      // Content-addressed retries preserve prior recoveries without growing on failed removes.
      for (const salvagePath of salvagePaths) {
        try {
          await vault.create(salvagePath, notesBlock, { mkdir: true });
          notesSalvaged = true;
          break;
        } catch (error) {
          if (!(error instanceof FsSafeError && error.code === "already-exists")) {
            break;
          }
          try {
            if (
              (await vault.readText(salvagePath, {
                maxBytes: MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES,
              })) === notesBlock
            ) {
              notesSalvaged = true;
              break;
            }
          } catch {
            break;
          }
        }
      }
      if (!notesSalvaged) {
        continue;
      }
    }
    if (pageContent !== undefined) {
      try {
        await vault.remove(entry.pagePath);
      } catch (error) {
        if (!(error instanceof FsSafeError && error.code === "not-found")) {
          continue;
        }
      }
    }
    removeImportedSourceStateEntry(params.state, entryKey);
    removedCount += 1;
  }
  return removedCount;
}

export function setImportedSourceEntry(params: {
  syncKey: string;
  entry: MemoryWikiImportedSourceStateEntry;
  state: MemoryWikiImportedSourceState;
}): void {
  const entryKey = resolveEntryKey(params.entry.group, params.syncKey);
  const current = params.state.entries[entryKey];
  if (
    current?.group === params.entry.group &&
    current.pagePath === params.entry.pagePath &&
    current.sourcePath === params.entry.sourcePath &&
    current.sourceUpdatedAtMs === params.entry.sourceUpdatedAtMs &&
    current.sourceSize === params.entry.sourceSize &&
    current.renderFingerprint === params.entry.renderFingerprint
  ) {
    return;
  }
  params.state.entries[entryKey] = params.entry;
  const changes = sourceSyncStateChanges.get(params.state);
  changes?.deleteKeys.delete(entryKey);
  changes?.upsertKeys.add(entryKey);
}

// Doctor detection helper: count legacy bare (vaultRootKey, syncKey) rows that
// `migrateMemoryWikiSourceSyncBareKeys` would rewrite to canonical keys.
export async function countMemoryWikiSourceSyncBareKeys(params: {
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  vaultRoot: string;
}): Promise<number> {
  const vaultRootKey = resolveVaultRootKey(params.vaultRoot);
  const store = params.openKeyedStore<MemoryWikiSourceSyncStateRecord>({
    namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
    maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  let legacyCount = 0;
  for (const row of await store.entries()) {
    const value = row.value;
    if (
      value.vaultRootKey !== vaultRootKey ||
      typeof value.syncKey !== "string" ||
      (value.group !== "bridge" && value.group !== "unsafe-local")
    ) {
      continue;
    }
    if (row.key !== resolveStateEntryKey(vaultRootKey, value.group, value.syncKey)) {
      legacyCount += 1;
    }
  }
  return legacyCount;
}

// Doctor-owned migration: rewrite pre-#118370 bare (vaultRootKey, syncKey) rows
// to canonical group-scoped keys. The namespace is `reject-new` at
// `MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES` entries, and the keyed-store API
// exposes only single-key operations (no cross-key transaction), so the
// relocation cannot be made atomic at this layer. To eliminate the permanent
// data-loss window, each legacy row is relocated insert-before-delete:
//   1. `registerIfAbsent(canonicalKey, value)` — write the canonical row first.
//      `registerIfAbsent` preserves any newer canonical row already written by a
//      concurrent runtime incremental sync (returns false, no overwrite).
//   2. Only after the canonical row exists, `deleteIf(legacyKey, isSameRecord)`
//      removes the legacy duplicate.
// A crash between steps 1 and 2 leaves legacy + canonical coexisting (a benign
// duplicate that `read` deduplicates and the next Doctor pass reclaims) — never
// a deleted legacy row with no canonical replacement, so page/Notes ownership is
// never orphaned. If the namespace is at the reject-new cap, step 1 throws
// `PLUGIN_STATE_LIMIT_EXCEEDED`; that row is skipped (legacy left intact, still
// usable via `read`'s transparent re-keying) and reported via `skippedCount` so
// the Doctor can warn the user to prune before rerunning. Runtime sync writes
// stay canonical-only.
export async function migrateMemoryWikiSourceSyncBareKeys(params: {
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  vaultRoot: string;
}): Promise<{ migratedCount: number; skippedCount: number }> {
  const vaultRootKey = resolveVaultRootKey(params.vaultRoot);
  const store = params.openKeyedStore<MemoryWikiSourceSyncStateRecord>({
    namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
    maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  let migratedCount = 0;
  let skippedCount = 0;
  for (const row of await store.entries()) {
    const value = row.value;
    if (
      value.vaultRootKey !== vaultRootKey ||
      typeof value.syncKey !== "string" ||
      (value.group !== "bridge" && value.group !== "unsafe-local")
    ) {
      continue;
    }
    const canonicalKey = resolveStateEntryKey(vaultRootKey, value.group, value.syncKey);
    if (row.key === canonicalKey) {
      continue;
    }
    // Insert the canonical row BEFORE deleting the legacy row. If a concurrent
    // runtime write already produced a newer canonical row, `registerIfAbsent`
    // returns false and we keep that newer value (no overwrite). A crash after
    // this point but before the delete leaves a benign duplicate that the next
    // pass reclaims — never an orphan.
    try {
      await store.registerIfAbsent(canonicalKey, value);
    } catch (error) {
      // Namespace is at the reject-new cap: there is no room to insert the
      // canonical row without first freeing a slot. Deleting the legacy row to
      // make room would reintroduce the loss window, so skip this row instead —
      // the legacy row remains and is still readable via `read`'s re-keying.
      if ((error as { code?: string }).code === "PLUGIN_STATE_LIMIT_EXCEEDED") {
        skippedCount += 1;
        continue;
      }
      throw error;
    }
    // The canonical row exists now; remove the legacy duplicate. `deleteIf`
    // removes only the exact value previously observed, so a concurrent runtime
    // write that changed the legacy row is not clobbered (left for the next pass).
    const removed = store.deleteIf
      ? await store.deleteIf(row.key, (current) => isSameRecord(current, value))
      : await store.delete(row.key);
    if (removed) {
      migratedCount += 1;
    }
  }
  return { migratedCount, skippedCount };
}

function isSameRecord(
  current: MemoryWikiSourceSyncStateRecord,
  expected: MemoryWikiSourceSyncStateRecord,
): boolean {
  return (
    current.vaultRootKey === expected.vaultRootKey &&
    current.group === expected.group &&
    current.syncKey === expected.syncKey &&
    current.pagePath === expected.pagePath &&
    current.sourcePath === expected.sourcePath &&
    current.sourceUpdatedAtMs === expected.sourceUpdatedAtMs &&
    current.sourceSize === expected.sourceSize &&
    current.renderFingerprint === expected.renderFingerprint
  );
}
