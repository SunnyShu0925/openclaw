import { createHash } from "node:crypto";
// Memory Wiki tests cover doctor migration of legacy source sync state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  OpenBlobStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { rollbackChatGptImportRun } from "./src/chatgpt-import.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
} from "./src/compiled-cache.js";
import { resolveMemoryWikiConfig } from "./src/config.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
  readMemoryWikiImportRunRecord,
} from "./src/import-runs-state.js";
import {
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
  readMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
} from "./src/source-sync-state.js";

// Local mirrors of the private key-resolution helpers in source-sync-state.ts,
// duplicated here so the production module need not export them for tests
// (which would trip the production knip unused-export gate). Keep in sync with
// `resolveVaultRootKey` / `resolveStateEntryKey`.
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

function requireStateMigration(id: string) {
  return expectDefined(
    stateMigrations.find((migration) => migration.id === id),
    `Memory Wiki state migration ${id}`,
  );
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-doctor-"));
  tempDirs.push(dir);
  return dir;
}

function resolveLegacyImportRunRecordPath(vaultRoot: string, runId: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs", `${runId}.json`);
}

function migrationParams(params: { stateDir: string; vaultRoot: string; agentIds?: string[] }) {
  const env = { ...process.env, HOME: params.stateDir, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    config: {
      ...(params.agentIds ? { agents: { list: params.agentIds.map((id) => ({ id })) } } : {}),
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              vault: {
                path: params.vaultRoot,
                ...(params.agentIds ? { scope: "agent" as const } : {}),
              },
            },
          },
        },
      },
    },
    env,
    stateDir: params.stateDir,
    oauthDir: path.join(params.stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
    },
  };
}

describe("memory-wiki doctor source sync migration", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(async () => {
    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiImportRunStateStore(undefined);
    resetPluginBlobStoreForTests();
    resetPluginStateStoreForTests();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("deletes rebuildable compiled cache files without importing them", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const cacheDir = path.join(vaultRoot, ".openclaw-wiki", "cache");
    const legacyPaths = [
      path.join(cacheDir, "agent-digest.json"),
      path.join(cacheDir, "claims.jsonl"),
    ];
    await fs.mkdir(cacheDir, { recursive: true });
    await Promise.all(legacyPaths.map((filePath) => fs.writeFile(filePath, "stale\n", "utf8")));
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: legacyPaths.map((filePath) =>
        expect.stringContaining(`Remove rebuildable Memory Wiki compiled cache: ${filePath}`),
      ),
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: legacyPaths.map(
        (filePath) => `Removed rebuildable Memory Wiki compiled cache: ${filePath}`,
      ),
      warnings: [],
    });
    await Promise.all(
      legacyPaths.map((filePath) =>
        expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
  });

  it("skips configured vaults that have not been initialized", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "missing-vault");
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("does not follow a symlinked legacy cache directory", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const externalCacheDir = path.join(stateDir, "external-cache");
    const externalCachePath = path.join(externalCacheDir, "agent-digest.json");
    await fs.mkdir(path.join(vaultRoot, ".openclaw-wiki"), { recursive: true });
    await fs.mkdir(externalCacheDir, { recursive: true });
    await fs.writeFile(externalCachePath, "private\n", "utf8");
    await fs.symlink(externalCacheDir, path.join(vaultRoot, ".openclaw-wiki", "cache"));
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(fs.readFile(externalCachePath, "utf8")).resolves.toBe("private\n");
  });

  it("detects and migrates legacy source-sync.json into plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          alpha: {
            group: "bridge",
            pagePath: "sources/alpha.md",
            sourcePath: "/tmp/alpha.md",
            sourceUpdatedAtMs: 100,
            sourceSize: 200,
            renderFingerprint: "alpha",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki source sync:")],
    });

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        "bridge\0alpha": {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/alpha.md",
          sourceUpdatedAtMs: 100,
          sourceSize: 200,
          renderFingerprint: "alpha",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
  });

  it("detects and migrates legacy import-run records into plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-alpha");
    const snapshotPath = path.join(
      vaultRoot,
      ".openclaw-wiki",
      "import-runs",
      "chatgpt-alpha",
      "snapshots",
      "alpha.md",
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    const legacyPagePath = path.join(vaultRoot, "sources", "legacy.md");
    const legacyPageContent = "# Edited legacy import page\n";
    await fs.mkdir(path.dirname(legacyPagePath), { recursive: true });
    await fs.writeFile(legacyPagePath, legacyPageContent, "utf8");
    await fs.writeFile(snapshotPath, "previous page\n", "utf8");
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 3,
        createdCount: 2,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: [
          "sources/legacy.md",
          { path: "sources/new.md", contentHash: "new-content-hash" },
        ],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki import runs:")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki import runs -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki import-run legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiImportRunRecord(vaultRoot, "chatgpt-alpha", store)).resolves.toEqual(
      {
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 3,
        createdCount: 2,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: [
          { path: "sources/legacy.md" },
          { path: "sources/new.md", contentHash: "new-content-hash" },
        ],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      },
    );
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
    await expect(fs.readFile(snapshotPath, "utf8")).resolves.toBe("previous page\n");

    configureMemoryWikiImportRunStateStore(store);
    const blobStoreEnv = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    configureMemoryWikiCompiledCacheStore(
      createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
        createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv),
      ),
    );
    const rollback = await rollbackChatGptImportRun({
      config: resolveMemoryWikiConfig({ vault: { path: vaultRoot } }),
      runId: "chatgpt-alpha",
    });
    const preservedLegacy = rollback.preservedPaths.find(
      (entry) => entry.path === "sources/legacy.md",
    );
    expect(preservedLegacy).toBeDefined();
    await expect(
      fs.readFile(path.join(vaultRoot, preservedLegacy?.recoveryPath ?? ""), "utf8"),
    ).resolves.toBe(legacyPageContent);
  });

  it("merges legacy entries with existing plugin state before archiving", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          stale: {
            group: "bridge",
            pagePath: "sources/stale.md",
            sourcePath: "/tmp/stale.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "stale",
          },
          current: {
            group: "bridge",
            pagePath: "sources/current-old.md",
            sourcePath: "/tmp/current-old.md",
            sourceUpdatedAtMs: 30,
            sourceSize: 40,
            renderFingerprint: "old",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await store.write(vaultRoot, {
      version: 1,
      entries: {
        current: {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });

    await expect(
      requireStateMigration("memory-wiki-source-sync-json-to-plugin-state").migrateLegacyState(
        params,
      ),
    ).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 1 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        "bridge\0stale": {
          group: "bridge",
          pagePath: "sources/stale.md",
          sourcePath: "/tmp/stale.md",
          sourceUpdatedAtMs: 10,
          sourceSize: 20,
          renderFingerprint: "stale",
        },
        "bridge\0current": {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy state from every configured agent vault", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vaults");
    const agentIds = ["support", "marketing"];
    for (const agentId of agentIds) {
      const legacyPath = resolveMemoryWikiSourceSyncStatePath(path.join(vaultRoot, agentId));
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({
          version: 1,
          entries: {
            [agentId]: {
              group: "bridge",
              pagePath: `sources/${agentId}.md`,
              sourcePath: `/tmp/${agentId}.md`,
              sourceUpdatedAtMs: 100,
              sourceSize: 200,
              renderFingerprint: agentId,
            },
          },
        })}\n`,
      );
    }

    const params = migrationParams({ stateDir, vaultRoot, agentIds });
    const migration = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        expect.stringContaining(path.join(vaultRoot, "support")),
        expect.stringContaining(path.join(vaultRoot, "marketing")),
      ],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      warnings: [],
    });

    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    for (const agentId of agentIds) {
      await expect(
        readMemoryWikiSourceSyncState(path.join(vaultRoot, agentId), store),
      ).resolves.toMatchObject({
        entries: { [`bridge\0${agentId}`]: { renderFingerprint: agentId } },
      });
    }
  });

  it("detects and migrates legacy bare-key ownership rows to group-scoped keys", async () => {
    // Regression for the #118370 upgrade path: pre-fix versions persisted each
    // ownership row under a bare (vaultRootKey, syncKey) key. The Doctor
    // migration rewrites these to canonical group-scoped keys so the runtime
    // sync path can stay canonical-only (no capacity-sensitive rewrite on the
    // hot path).
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-source-sync-bare-key-to-group-scoped");

    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const sourcePath = "/tmp/legacy-source.md";
    const legacyKey = createHash("sha256")
      .update(`${vaultRootKey}\0${sourcePath}`, "utf8")
      .digest("hex");
    const canonicalKey = resolveStateEntryKey(vaultRootKey, "bridge", sourcePath);
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

    const rawStore = createPluginStateKeyedStoreForTests("memory-wiki", {
      namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: params.env,
    });
    await rawStore.register(legacyKey, legacyRow);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("rewrite 1 legacy ownership key(s)")],
    });

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        `Rewrote 1 Memory Wiki source-sync ownership key(s) to group-scoped keys for ${vaultRoot}`,
      ],
      warnings: [],
    });

    // The legacy bare key is gone; only the canonical group-scoped key remains.
    const rows = await rawStore.entries();
    expect(rows.map((row) => row.key)).toEqual([canonicalKey]);

    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toMatchObject({
      entries: {
        [`bridge\0${sourcePath}`]: { group: "bridge", pagePath: "sources/legacy.md" },
      },
    });

    // Idempotent: a second detect/migrate pass finds nothing to rewrite.
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });
});
