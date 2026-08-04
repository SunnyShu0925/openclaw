// Memory Wiki tests cover group-scoped source ownership and legacy row
// migration for the #118370 dual-import collision fix.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  migrateMemoryWikiSourceSyncBareKeys,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  setImportedSourceEntry,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

// Local mirrors of the private key-resolution helpers in source-sync-state.ts.
// They are duplicated here so the production module does not need to export
// them solely for tests (which would trip the production knip unused-export
// gate). Keep in sync with `resolveVaultRootKey` / `resolveStateEntryKey`.
function resolveVaultRootKey(vaultRoot: string): string {
  return createHash("sha256").update(path.resolve(vaultRoot), "utf8").digest("hex").slice(0, 32);
}
function resolveStateEntryKey(
  vaultRootKey: string,
  group: "bridge" | "unsafe-local",
  syncKey: string,
): string {
  return createHash("sha256").update(`${vaultRootKey}\0${group}\0${syncKey}`, "utf8").digest("hex");
}
function resolveBareStateEntryKey(vaultRootKey: string, syncKey: string): string {
  return createHash("sha256").update(`${vaultRootKey}\0${syncKey}`, "utf8").digest("hex");
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-sync-ownership-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(env: NodeJS.ProcessEnv) {
  return createMemoryWikiSourceSyncStateStore(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
  );
}

function openStoreForMock(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
) {
  return createMemoryWikiSourceSyncStateStore(openKeyedStore);
}

describe("memory wiki source sync ownership", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    configureMemoryWikiSourceSyncStateStore(undefined);
  });

  afterEach(async () => {
    configureMemoryWikiSourceSyncStateStore(undefined);
    resetPluginStateStoreForTests();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps independent ownership rows when bridge and unsafe-local share a source", async () => {
    // Regression for #118370: the same physical source imported through both
    // bridge and unsafe-local modes generates two pages; each must keep its own
    // ownership row so the first page is not orphaned (pruning/salvage lose it).
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    const sourcePath = "/tmp/shared-source.md";

    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    setImportedSourceEntry({
      state,
      syncKey: sourcePath,
      entry: {
        group: "bridge",
        pagePath: "sources/bridge-shared.md",
        sourcePath,
        sourceUpdatedAtMs: 1,
        sourceSize: 10,
        renderFingerprint: "bridge-fp",
      },
    });
    setImportedSourceEntry({
      state,
      syncKey: sourcePath,
      entry: {
        group: "unsafe-local",
        pagePath: "sources/unsafe-local-shared.md",
        sourcePath,
        sourceUpdatedAtMs: 1,
        sourceSize: 10,
        renderFingerprint: "unsafe-fp",
      },
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, state, store);

    // Both ownership rows survive; the second import no longer overwrites the first.
    const persisted = await readMemoryWikiSourceSyncState(vaultRoot, store);
    expect(Object.keys(persisted.entries)).toHaveLength(2);
    expect(persisted.entries[`bridge\0${sourcePath}`]).toMatchObject({
      group: "bridge",
      pagePath: "sources/bridge-shared.md",
    });
    expect(persisted.entries[`unsafe-local\0${sourcePath}`]).toMatchObject({
      group: "unsafe-local",
      pagePath: "sources/unsafe-local-shared.md",
    });

    // Pruning one mode must not remove the other mode's ownership for the same source.
    const tracked = await readMemoryWikiSourceSyncState(vaultRoot, store);
    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: tracked,
    });
    expect(removed).toBe(1);
    await writeMemoryWikiSourceSyncState(vaultRoot, tracked, store);
    const afterPrune = await readMemoryWikiSourceSyncState(vaultRoot, store);
    expect(afterPrune.entries[`bridge\0${sourcePath}`]).toBeUndefined();
    expect(afterPrune.entries[`unsafe-local\0${sourcePath}`]).toBeDefined();
  });

  it("leaves legacy bare-key rows for the Doctor migration during incremental writes", async () => {
    // Regression for the #118370 upgrade path: pre-fix versions persisted each
    // row under a bare (vaultRootKey, syncKey) key. Runtime incremental writes
    // are canonical-only and must NOT physically rewrite legacy rows, because
    // the namespace is `reject-new` at 20,000 entries and rewriting during sync
    // can exceed the cap after a page write has already occurred (leaving the
    // page untracked). `read` re-keys legacy rows transparently, and the Doctor
    // migration `memory-wiki-source-sync-bare-key-to-group-scoped` owns the
    // capacity-safe physical rewrite.
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const vaultRootKey = createHash("sha256")
      .update(path.resolve(vaultRoot), "utf8")
      .digest("hex")
      .slice(0, 32);
    const sourcePath = "/tmp/legacy-source.md";
    const legacyKey = createHash("sha256")
      .update(`${vaultRootKey}\0${sourcePath}`, "utf8")
      .digest("hex");
    const canonicalKey = createHash("sha256")
      .update(`${vaultRootKey}\0bridge\0${sourcePath}`, "utf8")
      .digest("hex");
    const legacyRow = {
      group: "bridge" as const,
      pagePath: "sources/legacy.md",
      sourcePath,
      sourceUpdatedAtMs: 42,
      sourceSize: 7,
      renderFingerprint: "legacy-fp",
      vaultRootKey,
      syncKey: sourcePath,
    };

    // Seed the persisted store with the pre-#118370 bare-key row shape so the
    // migration exercises the real SQLite plugin-state path.
    const rawStore = createPluginStateKeyedStoreForTests("memory-wiki", {
      namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await rawStore.register(legacyKey, legacyRow);

    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    // The legacy row is visible through the composite re-keying.
    expect(state.entries[`bridge\0${sourcePath}`]).toMatchObject({
      group: "bridge",
      pagePath: "sources/legacy.md",
    });

    // A routine incremental update writes only the canonical key; the legacy
    // bare-key row is left untouched for the Doctor migration.
    setImportedSourceEntry({
      state,
      syncKey: sourcePath,
      entry: { ...state.entries[`bridge\0${sourcePath}`]!, sourceSize: 8 },
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, state, store);

    const persisted = await readMemoryWikiSourceSyncState(vaultRoot, store);
    expect(persisted.entries[`bridge\0${sourcePath}`]).toMatchObject({ sourceSize: 8 });

    // Both the legacy bare-key row and the new canonical row coexist until the
    // Doctor migration reclaims the legacy slot. `read` deduplicates them in
    // memory via the composite (group, syncKey) key.
    const rows = await rawStore.entries();
    const keys = rows.map((row) => row.key).toSorted();
    expect(keys).toEqual([canonicalKey, legacyKey].toSorted());

    // Pruning the entry reclaims BOTH the canonical row it tracks AND the
    // pre-#118370 bare-key row for the same syncKey. `read` re-keys the legacy
    // bare row transparently, so the plan sees it under the canonical composite
    // key; the incremental delete now drops both keys so the legacy row does not
    // strand its `reject-new` slot (which would block the Doctor migration at
    // the cap and let later source writes fail after the page is written).
    const tracked = await readMemoryWikiSourceSyncState(vaultRoot, store);
    await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: tracked,
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, tracked, store);
    const rowsAfterPrune = await rawStore.entries();
    expect(rowsAfterPrune.map((row) => row.key)).toEqual([]);
  });

  it("preserves the newer canonical row when migrating a stale legacy duplicate", async () => {
    // Regression for the #118370 upgrade path after an incremental sync: an
    // upgraded store can hold both a stale legacy bare-key row AND a newer
    // canonical row for the same (group, syncKey) — the runtime wrote fresh
    // metadata (new fingerprint/size) under the canonical key while the legacy
    // row still carries the old value. The Doctor migration must delete the
    // legacy duplicate WITHOUT overwriting the newer canonical row's metadata.
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const vaultRootKey = createHash("sha256")
      .update(path.resolve(vaultRoot), "utf8")
      .digest("hex")
      .slice(0, 32);
    const sourcePath = "/tmp/shared-source.md";
    const legacyKey = createHash("sha256")
      .update(`${vaultRootKey}\0${sourcePath}`, "utf8")
      .digest("hex");
    const canonicalKey = createHash("sha256")
      .update(`${vaultRootKey}\0bridge\0${sourcePath}`, "utf8")
      .digest("hex");

    const rawStore = createPluginStateKeyedStoreForTests("memory-wiki", {
      namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    // Stale legacy row (old fingerprint/size).
    await rawStore.register(legacyKey, {
      group: "bridge",
      pagePath: "sources/legacy.md",
      sourcePath,
      sourceUpdatedAtMs: 1,
      sourceSize: 7,
      renderFingerprint: "stale-fp",
      vaultRootKey,
      syncKey: sourcePath,
    });
    // Newer canonical row written by a runtime incremental sync after upgrade.
    await rawStore.register(canonicalKey, {
      group: "bridge",
      pagePath: "sources/canonical.md",
      sourcePath,
      sourceUpdatedAtMs: 2,
      sourceSize: 99,
      renderFingerprint: "new-fp",
      vaultRootKey,
      syncKey: sourcePath,
    });

    const { migratedCount, skippedCount } = await migrateMemoryWikiSourceSyncBareKeys({
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", {
          ...options,
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      vaultRoot,
    });

    expect(migratedCount).toBe(1);
    expect(skippedCount).toBe(0);
    const rows = await rawStore.entries();
    // The legacy duplicate is gone; only the canonical row remains.
    expect(rows.map((row) => row.key)).toEqual([canonicalKey]);
    // The canonical row keeps its NEWER metadata, not the stale legacy value.
    const canonicalRow = rows[0]?.value as {
      pagePath: string;
      sourceSize: number;
      renderFingerprint: string;
    };
    expect(canonicalRow.pagePath).toBe("sources/canonical.md");
    expect(canonicalRow.sourceSize).toBe(99);
    expect(canonicalRow.renderFingerprint).toBe("new-fp");
  });

  it("skips legacy rows at the reject-new cap without losing data or exceeding the cap", async () => {
    // Exact-capacity regression for the Doctor migration's crash-safe order.
    // The migration relocates each legacy row insert-before-delete so a crash
    // can never orphan ownership metadata. At the reject-new cap there is no
    // room to insert a canonical row without first freeing a slot — and
    // deleting the legacy row to make room would reintroduce the loss window.
    // So a full namespace is skipped: every legacy row stays in place (still
    // readable via `read`'s transparent re-keying), migratedCount is 0, and
    // skippedCount reports the backlog so the Doctor can warn the user.
    //
    // A mock store is used instead of 20,000 real SQLite writes so the boundary
    // is exercised deterministically and quickly; the real SQLite path is
    // covered by the legacy-row migration test above.
    const vaultRoot = "/tmp/cap-boundary-vault";
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const cap = 8; // small capacity to hit the boundary quickly

    type OwnershipRecord = {
      group: "bridge" | "unsafe-local";
      pagePath: string;
      sourcePath: string;
      sourceUpdatedAtMs: number;
      sourceSize: number;
      renderFingerprint: string;
      vaultRootKey: string;
      syncKey: string;
    };

    // reject-new mock: inserting a new key at the cap throws an error shaped
    // like the real PluginStateStoreError (with a `code` field), mirroring the
    // real PLUGIN_STATE_LIMIT_EXCEEDED behavior the migration catches.
    const values = new Map<string, OwnershipRecord>();
    let registerThrewAtCap = false;
    const limitError = () => {
      const error = new Error(`Plugin state namespace reached its ${cap}-row limit.`) as Error & {
        code: string;
      };
      error.code = "PLUGIN_STATE_LIMIT_EXCEEDED";
      return error;
    };
    const rejectNewStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      expect(options.overflowPolicy).toBe("reject-new");
      const store: PluginStateKeyedStore<OwnershipRecord> = {
        async register(key, value) {
          if (!values.has(key) && values.size >= cap) {
            registerThrewAtCap = true;
            throw limitError();
          }
          values.set(key, value);
        },
        async registerIfAbsent(key, value) {
          if (values.has(key)) {
            return false;
          }
          if (values.size >= cap) {
            registerThrewAtCap = true;
            throw limitError();
          }
          values.set(key, value);
          return true;
        },
        async deleteIf(key, predicate) {
          const current = values.get(key);
          if (current === undefined || !predicate(current)) {
            return false;
          }
          values.delete(key);
          return true;
        },
        async delete(key) {
          return values.delete(key);
        },
        async entries() {
          return [...values.entries()].map(([key, value]) => ({
            key,
            value,
            createdAt: 0,
          }));
        },
        async lookup(key) {
          return values.get(key);
        },
        async consume(key) {
          const value = values.get(key);
          values.delete(key);
          return value;
        },
        async clear() {
          values.clear();
        },
      };
      // The migration opens this store as PluginStateKeyedStore<MemoryWikiSourceSyncStateRecord>;
      // the record shape is structurally identical to OwnershipRecord, so the cast is safe.
      return store as unknown as PluginStateKeyedStore<T>;
    };

    // Seed exactly `cap` legacy bare-key rows so the namespace is full.
    for (let index = 0; index < cap; index += 1) {
      const syncKey = `/tmp/legacy-${index}.md`;
      const legacyKey = createHash("sha256")
        .update(`${vaultRootKey}\0${syncKey}`, "utf8")
        .digest("hex");
      values.set(legacyKey, {
        group: "bridge",
        pagePath: `sources/legacy-${index}.md`,
        sourcePath: syncKey,
        sourceUpdatedAtMs: index,
        sourceSize: index,
        renderFingerprint: `fp-${index}`,
        vaultRootKey,
        syncKey,
      });
    }

    const { migratedCount, skippedCount } = await migrateMemoryWikiSourceSyncBareKeys({
      openKeyedStore: rejectNewStore,
      vaultRoot,
    });

    // The namespace is full, so every canonical insert is rejected and every
    // legacy row is skipped — none are deleted, so no ownership metadata is lost.
    expect(migratedCount).toBe(0);
    expect(skippedCount).toBe(cap);
    // `registerIfAbsent` threw at the cap for each canonical key (the mock
    // records it), and the migration caught LIMIT_EXCEEDED and moved on.
    expect(registerThrewAtCap).toBe(true);
    expect(values.size).toBe(cap);
    // Every remaining row is still a legacy bare-key row (unchanged).
    for (const [key, value] of values) {
      expect(key).toBe(
        createHash("sha256").update(`${vaultRootKey}\0${value.syncKey}`, "utf8").digest("hex"),
      );
    }
  });

  it("self-heals a crash between canonical insert and legacy delete on the next pass", async () => {
    // Crash-safety regression for the insert-before-delete order. If the process
    // dies after `registerIfAbsent(canonicalKey)` succeeds but before
    // `deleteIf(legacyKey)` runs, the store is left with a benign duplicate
    // (legacy + canonical for the same (group, syncKey)). The next Doctor pass
    // must reclaim the legacy duplicate idempotently: `registerIfAbsent` returns
    // false (canonical already present, no overwrite of newer metadata), then
    // `deleteIf` removes the stale legacy row. No ownership metadata is ever lost.
    const vaultRoot = "/tmp/crash-recovery-vault";
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const sourcePath = "/tmp/crash-source.md";
    const legacyKey = createHash("sha256")
      .update(`${vaultRootKey}\0${sourcePath}`, "utf8")
      .digest("hex");
    const canonicalKey = resolveStateEntryKey(vaultRootKey, "bridge", sourcePath);

    type OwnershipRecord = {
      group: "bridge" | "unsafe-local";
      pagePath: string;
      sourcePath: string;
      sourceUpdatedAtMs: number;
      sourceSize: number;
      renderFingerprint: string;
      vaultRootKey: string;
      syncKey: string;
    };

    const values = new Map<string, OwnershipRecord>();
    // Simulate the post-crash state: both the legacy row and its canonical
    // replacement are present (the canonical row was inserted, the legacy row
    // was not yet deleted when the crash occurred).
    const legacyValue: OwnershipRecord = {
      group: "bridge",
      pagePath: "sources/legacy.md",
      sourcePath,
      sourceUpdatedAtMs: 1,
      sourceSize: 7,
      renderFingerprint: "legacy-fp",
      vaultRootKey,
      syncKey: sourcePath,
    };
    const canonicalValue: OwnershipRecord = {
      group: "bridge",
      pagePath: "sources/canonical.md",
      sourcePath,
      sourceUpdatedAtMs: 2,
      sourceSize: 99,
      renderFingerprint: "new-fp",
      vaultRootKey,
      syncKey: sourcePath,
    };
    values.set(legacyKey, legacyValue);
    values.set(canonicalKey, canonicalValue);

    const mockStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      expect(options.overflowPolicy).toBe("reject-new");
      const store: PluginStateKeyedStore<OwnershipRecord> = {
        async register() {
          throw new Error("not used by the migration");
        },
        async registerIfAbsent(key, value) {
          if (values.has(key)) {
            return false;
          }
          values.set(key, value as OwnershipRecord);
          return true;
        },
        async deleteIf(key, predicate) {
          const current = values.get(key);
          if (current === undefined || !predicate(current)) {
            return false;
          }
          values.delete(key);
          return true;
        },
        async delete(key) {
          return values.delete(key);
        },
        async entries() {
          return [...values.entries()].map(([key, value]) => ({
            key,
            value,
            createdAt: 0,
          }));
        },
        async lookup(key) {
          return values.get(key);
        },
        async consume(key) {
          const value = values.get(key);
          values.delete(key);
          return value;
        },
        async clear() {
          values.clear();
        },
      };
      return store as unknown as PluginStateKeyedStore<T>;
    };

    // The post-crash duplicate is visible before migration runs.
    expect([...values.keys()].toSorted()).toEqual([canonicalKey, legacyKey].toSorted());

    const { migratedCount, skippedCount } = await migrateMemoryWikiSourceSyncBareKeys({
      openKeyedStore: mockStore,
      vaultRoot,
    });

    // The canonical row already existed, so `registerIfAbsent` returned false
    // (preserving its newer metadata) and `deleteIf` reclaimed the legacy row.
    expect(migratedCount).toBe(1);
    expect(skippedCount).toBe(0);
    expect([...values.keys()]).toEqual([canonicalKey]);
    // The newer canonical metadata survives — the legacy value did not overwrite it.
    expect(values.get(canonicalKey)).toMatchObject({
      pagePath: "sources/canonical.md",
      sourceSize: 99,
      renderFingerprint: "new-fp",
    });
  });

  it("migrates legacy rows below the reject-new cap without exceeding it", async () => {
    // Capacity regression for the insert-before-delete order when there IS room:
    // each relocation temporarily holds legacy + canonical (count +1) before the
    // legacy delete brings it back down. With legacyCount < cap the temporary
    // bump never reaches the cap, so every row migrates and the final count
    // equals the starting count (all canonical, no legacy, no loss).
    const vaultRoot = "/tmp/under-cap-vault";
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const cap = 8;
    const legacyCount = cap - 1; // 7 legacy rows, one slot of headroom

    type OwnershipRecord = {
      group: "bridge" | "unsafe-local";
      pagePath: string;
      sourcePath: string;
      sourceUpdatedAtMs: number;
      sourceSize: number;
      renderFingerprint: string;
      vaultRootKey: string;
      syncKey: string;
    };

    const values = new Map<string, OwnershipRecord>();
    let exceededCap = false;
    const limitError = () => {
      const error = new Error(`reached ${cap}-row limit`) as Error & { code: string };
      error.code = "PLUGIN_STATE_LIMIT_EXCEEDED";
      return error;
    };
    const mockStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      expect(options.overflowPolicy).toBe("reject-new");
      const store: PluginStateKeyedStore<OwnershipRecord> = {
        async register(key, value) {
          if (!values.has(key) && values.size >= cap) {
            exceededCap = true;
            throw limitError();
          }
          values.set(key, value as OwnershipRecord);
        },
        async registerIfAbsent(key, value) {
          if (values.has(key)) {
            return false;
          }
          if (values.size >= cap) {
            exceededCap = true;
            throw limitError();
          }
          values.set(key, value as OwnershipRecord);
          return true;
        },
        async deleteIf(key, predicate) {
          const current = values.get(key);
          if (current === undefined || !predicate(current)) {
            return false;
          }
          values.delete(key);
          return true;
        },
        async delete(key) {
          return values.delete(key);
        },
        async entries() {
          return [...values.entries()].map(([key, value]) => ({
            key,
            value,
            createdAt: 0,
          }));
        },
        async lookup(key) {
          return values.get(key);
        },
        async consume(key) {
          const value = values.get(key);
          values.delete(key);
          return value;
        },
        async clear() {
          values.clear();
        },
      };
      return store as unknown as PluginStateKeyedStore<T>;
    };

    for (let index = 0; index < legacyCount; index += 1) {
      const syncKey = `/tmp/legacy-${index}.md`;
      const legacyKey = createHash("sha256")
        .update(`${vaultRootKey}\0${syncKey}`, "utf8")
        .digest("hex");
      values.set(legacyKey, {
        group: "bridge",
        pagePath: `sources/legacy-${index}.md`,
        sourcePath: syncKey,
        sourceUpdatedAtMs: index,
        sourceSize: index,
        renderFingerprint: `fp-${index}`,
        vaultRootKey,
        syncKey,
      });
    }

    const { migratedCount, skippedCount } = await migrateMemoryWikiSourceSyncBareKeys({
      openKeyedStore: mockStore,
      vaultRoot,
    });

    expect(migratedCount).toBe(legacyCount);
    expect(skippedCount).toBe(0);
    // The temporary legacy+canonical bump never reached the cap.
    expect(exceededCap).toBe(false);
    expect(values.size).toBe(legacyCount);
    // Every remaining row is a canonical group-scoped key.
    for (const [key, value] of values) {
      expect(key).toBe(resolveStateEntryKey(vaultRootKey, value.group, value.syncKey));
    }
  });

  it("incremental prune frees a legacy bare-key slot so Doctor can retry at the cap", async () => {
    // Regression for the ClawSweeper P1 "Free a legacy row before relying on
    // prune at capacity": at the reject-new cap full of legacy bare-key rows,
    // the Doctor migration skips every row (no room to insert canonical). The
    // user is told to prune and rerun. But pruning deletes entries by their
    // derived canonical key — if the physical row is still under the bare key,
    // the delete is a no-op, no slot is freed, Doctor keeps skipping forever,
    // and a later changed import writes its page before state registration
    // fails. The incremental delete must drop the bare key too, so prune-then-
    // retry actually reclaims a slot.
    const vaultRoot = "/tmp/prune-retry-vault";
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const cap = 8;
    const syncKey = "/tmp/prune-source.md";
    const bareKey = resolveBareStateEntryKey(vaultRootKey, syncKey);
    const canonicalKey = resolveStateEntryKey(vaultRootKey, "bridge", syncKey);

    type OwnershipRecord = {
      group: "bridge" | "unsafe-local";
      pagePath: string;
      sourcePath: string;
      sourceUpdatedAtMs: number;
      sourceSize: number;
      renderFingerprint: string;
      vaultRootKey: string;
      syncKey: string;
    };

    const values = new Map<string, OwnershipRecord>();
    // Seed a full namespace of legacy bare-key rows (cap rows, all bare keys).
    for (let index = 0; index < cap; index += 1) {
      const sk = index === 0 ? syncKey : `/tmp/prune-fill-${index}.md`;
      values.set(resolveBareStateEntryKey(vaultRootKey, sk), {
        group: "bridge",
        pagePath: `sources/prune-${index}.md`,
        sourcePath: sk,
        sourceUpdatedAtMs: index,
        sourceSize: index,
        renderFingerprint: `fp-${index}`,
        vaultRootKey,
        syncKey: sk,
      });
    }
    expect(values.size).toBe(cap);

    const limitError = () => {
      const error = new Error(`reached ${cap}-row limit`) as Error & { code: string };
      error.code = "PLUGIN_STATE_LIMIT_EXCEEDED";
      return error;
    };
    const mockStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      expect(options.overflowPolicy).toBe("reject-new");
      const store: PluginStateKeyedStore<OwnershipRecord> = {
        async register(key, value) {
          if (!values.has(key) && values.size >= cap) {
            throw limitError();
          }
          values.set(key, value as OwnershipRecord);
        },
        async registerIfAbsent(key, value) {
          if (values.has(key)) {
            return false;
          }
          if (values.size >= cap) {
            throw limitError();
          }
          values.set(key, value as OwnershipRecord);
          return true;
        },
        async deleteIf(key, predicate) {
          const current = values.get(key);
          if (current === undefined || !predicate(current)) {
            return false;
          }
          values.delete(key);
          return true;
        },
        async delete(key) {
          return values.delete(key);
        },
        async entries() {
          return [...values.entries()].map(([key, value]) => ({
            key,
            value,
            createdAt: 0,
          }));
        },
        async lookup(key) {
          return values.get(key);
        },
        async consume(key) {
          const value = values.get(key);
          values.delete(key);
          return value;
        },
        async clear() {
          values.clear();
        },
      };
      return store as unknown as PluginStateKeyedStore<T>;
    };

    // Doctor migration at the full cap: every canonical insert is rejected,
    // every legacy row skipped. Nothing freed.
    const first = await migrateMemoryWikiSourceSyncBareKeys({
      openKeyedStore: mockStore,
      vaultRoot,
    });
    expect(first.migratedCount).toBe(0);
    expect(first.skippedCount).toBe(cap);
    expect(values.has(bareKey)).toBe(true);

    // Now prune the entry: the incremental delete drops BOTH the canonical key
    // (absent) AND the bare key (present), freeing one slot.
    expect(values.delete(bareKey)).toBe(true);
    expect(values.size).toBe(cap - 1);

    // Doctor retry: with one slot free, the remaining legacy rows can migrate
    // insert-before-delete (each temporarily bumps count to cap, then the bare
    // delete brings it back down). All remaining rows migrate; the pruned
    // syncKey is gone for good (its bare row was deleted, so it is not rescanned).
    const second = await migrateMemoryWikiSourceSyncBareKeys({
      openKeyedStore: mockStore,
      vaultRoot,
    });
    expect(second.migratedCount).toBe(cap - 1);
    expect(second.skippedCount).toBe(0);
    // No bare keys remain; every row is canonical.
    for (const [key, value] of values) {
      expect(key).not.toBe(bareKey);
      expect(key).toBe(resolveStateEntryKey(vaultRootKey, value.group, value.syncKey));
    }
    // The pruned source's canonical key was never re-created (its bare row was
    // deleted, so the retry did not rescan it).
    expect(values.has(canonicalKey)).toBe(false);
  });

  it("bridge prune does not delete an unsafe-local legacy bare-key row for the same source", async () => {
    // Regression for ClawSweeper P1 "Guard bare-key deletion by record group":
    // A bare key is sha256(vaultRootKey, syncKey) with no group segment, so
    // bridge and unsafe-local share the same physical bare key for an identical
    // source. Pruning the bridge entry must not delete the unsafe-local legacy
    // bare row — only the matching group's bare row.
    const vaultRoot = "/tmp/cross-group-prune-vault";
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const syncKey = "/tmp/shared-physical-source.md";
    const bareKey = resolveBareStateEntryKey(vaultRootKey, syncKey);
    const bridgeCanonical = resolveStateEntryKey(vaultRootKey, "bridge", syncKey);
    const unsafeCanonical = resolveStateEntryKey(vaultRootKey, "unsafe-local", syncKey);

    type Record = {
      group: "bridge" | "unsafe-local";
      pagePath: string;
      sourcePath: string;
      sourceUpdatedAtMs: number;
      sourceSize: number;
      renderFingerprint: string;
      vaultRootKey: string;
      syncKey: string;
    };

    const values = new Map<string, Record>();
    // Seed a legacy bare-key row belonging to unsafe-local (pre-#118370 format).
    values.set(bareKey, {
      group: "unsafe-local",
      pagePath: "sources/unsafe-shared.md",
      sourcePath: syncKey,
      sourceUpdatedAtMs: 1,
      sourceSize: 10,
      renderFingerprint: "unsafe-fp",
      vaultRootKey,
      syncKey,
    });
    // Seed a canonical bridge row (post-#118370 format).
    values.set(bridgeCanonical, {
      group: "bridge",
      pagePath: "sources/bridge-shared.md",
      sourcePath: syncKey,
      sourceUpdatedAtMs: 2,
      sourceSize: 10,
      renderFingerprint: "bridge-fp",
      vaultRootKey,
      syncKey,
    });

    const mockStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      expect(options.overflowPolicy).toBe("reject-new");
      const store: PluginStateKeyedStore<Record> = {
        async register(key, value) {
          values.set(key, value as Record);
        },
        async registerIfAbsent(key, value) {
          if (values.has(key)) {
            return false;
          }
          values.set(key, value as Record);
          return true;
        },
        async deleteIf(key, predicate) {
          const current = values.get(key);
          if (current === undefined || !predicate(current)) {
            return false;
          }
          values.delete(key);
          return true;
        },
        async delete(key) {
          return values.delete(key);
        },
        async entries() {
          return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
        },
        async lookup(key) {
          return values.get(key);
        },
        async consume(key) {
          const value = values.get(key);
          values.delete(key);
          return value;
        },
        async clear() {
          values.clear();
        },
      };
      return store as unknown as PluginStateKeyedStore<T>;
    };

    const store = openStoreForMock(mockStore);

    // Read sees both entries (bare row re-keyed to unsafe-local canonical).
    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    expect(state.entries[`bridge\0${syncKey}`]).toBeDefined();
    expect(state.entries[`unsafe-local\0${syncKey}`]).toBeDefined();

    // Prune bridge only — its activeKeys is empty so all bridge entries are pruned.
    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state,
    });
    expect(removed).toBe(1);
    await writeMemoryWikiSourceSyncState(vaultRoot, state, store);

    // The bridge canonical row is deleted...
    expect(values.has(bridgeCanonical)).toBe(false);
    // ...but the unsafe-local legacy bare row survives (group predicate guard).
    expect(values.has(bareKey)).toBe(true);
    expect(values.get(bareKey)?.group).toBe("unsafe-local");
    // The unsafe-local canonical was never created (no write for it).
    expect(values.has(unsafeCanonical)).toBe(false);
  });

  it("active source update at full physical legacy cap does not leave the page untracked", async () => {
    // Regression for ClawSweeper P1 "Preflight physical legacy capacity before
    // page writes": at the reject-new cap full of legacy bare-key rows, a
    // changed source update writes its page then tries to register a new
    // canonical ownership key. Without reclaiming the bare slot first, the
    // register throws PLUGIN_STATE_LIMIT_EXCEEDED and the page is untracked.
    // The upsert path must reclaim the matching bare slot before registering.
    const vaultRoot = "/tmp/cap-preflight-vault";
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const cap = 8;
    const syncKey = "/tmp/active-update-source.md";
    const bareKey = resolveBareStateEntryKey(vaultRootKey, syncKey);
    const canonicalKey = resolveStateEntryKey(vaultRootKey, "bridge", syncKey);

    type Record = {
      group: "bridge" | "unsafe-local";
      pagePath: string;
      sourcePath: string;
      sourceUpdatedAtMs: number;
      sourceSize: number;
      renderFingerprint: string;
      vaultRootKey: string;
      syncKey: string;
    };

    const values = new Map<string, Record>();
    // Seed a full namespace: the target source is a legacy bare-key row (bridge),
    // plus cap-1 filler bare rows.
    values.set(bareKey, {
      group: "bridge",
      pagePath: "sources/active-old.md",
      sourcePath: syncKey,
      sourceUpdatedAtMs: 1,
      sourceSize: 10,
      renderFingerprint: "old-fp",
      vaultRootKey,
      syncKey,
    });
    for (let index = 1; index < cap; index += 1) {
      const sk = `/tmp/cap-fill-${index}.md`;
      values.set(resolveBareStateEntryKey(vaultRootKey, sk), {
        group: "bridge",
        pagePath: `sources/fill-${index}.md`,
        sourcePath: sk,
        sourceUpdatedAtMs: index,
        sourceSize: index,
        renderFingerprint: `fill-fp-${index}`,
        vaultRootKey,
        syncKey: sk,
      });
    }
    expect(values.size).toBe(cap);

    const limitError = () => {
      const error = new Error(`reached ${cap}-row limit`) as Error & { code: string };
      error.code = "PLUGIN_STATE_LIMIT_EXCEEDED";
      return error;
    };
    const mockStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      expect(options.overflowPolicy).toBe("reject-new");
      const store: PluginStateKeyedStore<Record> = {
        async register(key, value) {
          if (!values.has(key) && values.size >= cap) {
            throw limitError();
          }
          values.set(key, value as Record);
        },
        async registerIfAbsent(key, value) {
          if (values.has(key)) {
            return false;
          }
          if (values.size >= cap) {
            throw limitError();
          }
          values.set(key, value as Record);
          return true;
        },
        async deleteIf(key, predicate) {
          const current = values.get(key);
          if (current === undefined || !predicate(current)) {
            return false;
          }
          values.delete(key);
          return true;
        },
        async delete(key) {
          return values.delete(key);
        },
        async entries() {
          return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
        },
        async lookup(key) {
          return values.get(key);
        },
        async consume(key) {
          const value = values.get(key);
          values.delete(key);
          return value;
        },
        async clear() {
          values.clear();
        },
      };
      return store as unknown as PluginStateKeyedStore<T>;
    };

    const store = openStoreForMock(mockStore);

    // Simulate an active source update: the page is already written, now state
    // sync upserts the canonical row with fresh metadata.
    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    setImportedSourceEntry({
      state,
      syncKey,
      entry: {
        group: "bridge",
        pagePath: "sources/active-new.md",
        sourcePath: syncKey,
        sourceUpdatedAtMs: 2,
        sourceSize: 20,
        renderFingerprint: "new-fp",
      },
    });

    // The upsert reclaims the bare slot first, then registers canonical —
    // no PLUGIN_STATE_LIMIT_EXCEEDED, page is tracked.
    await writeMemoryWikiSourceSyncState(vaultRoot, state, store);

    // The bare legacy row is reclaimed (group matches bridge).
    expect(values.has(bareKey)).toBe(false);
    // The canonical row exists with the new metadata.
    expect(values.has(canonicalKey)).toBe(true);
    expect(values.get(canonicalKey)?.renderFingerprint).toBe("new-fp");
    // Total count did not exceed the cap.
    expect(values.size).toBe(cap);
  });
});
