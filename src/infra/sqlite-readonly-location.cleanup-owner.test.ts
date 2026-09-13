import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CleanupFailureReport,
  SnapshotCleanupWarning,
} from "./sqlite-readonly-location-cleanup.js";
import { adoptPreparedLocation } from "./sqlite-readonly-location.js";

// chmod-based denial only works on POSIX where the process is not root
// (root bypasses mode bits, and Windows chmod does not revoke deletion ACLs).
const supportsChmodDenial =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

let root: string;

beforeEach(async () => {
  root = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "snapshot-cleanup-owner-")),
  );
});

afterEach(async () => {
  // Restore permissions so the fixture can be removed even when a test revoked
  // write access on a parent to trigger a real cleanup failure.
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  await fs.promises.rm(root, { recursive: true, force: true });
});

// Revoke write access on the parent so fs.rmSync cannot unlink the owned root.
// This is a real filesystem failure at the cleanup boundary, not a mocked rm.
async function revokeParentWrite(): Promise<void> {
  await fs.promises.chmod(root, 0o500);
}

describe.runIf(supportsChmodDenial)("chmod-denied cleanup failure", () => {
  it("emits a non-throwing warning when cleanup cannot remove the owned directory", async () => {
    const ownedRoot = path.join(root, "owned");
    const location = path.join(ownedRoot, "database.sqlite");
    await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(location, "snapshot bytes");

    const reports: CleanupFailureReport[] = [];
    const prepared = adoptPreparedLocation(location, ownedRoot, false, (report) =>
      reports.push(report),
    );

    await revokeParentWrite();
    try {
      expect(prepared.cleanup()).toBe(false);
    } finally {
      await fs.promises.chmod(root, 0o700);
    }

    expect(reports).toHaveLength(1);
    expect(reports[0]?.cleanupRoot).toBe(ownedRoot);
    // The owned copy remains on disk; the exit handler retries removal later.
    expect(fs.existsSync(ownedRoot)).toBe(true);
    // A successful read's outcome is preserved: cleanup did not throw, and repeated
    // attempts never duplicate the diagnostic — the owner records the failure once.
    prepared.cleanup();
    expect(reports).toHaveLength(1);
  });
});

it("does not emit a warning when cleanup succeeds", async () => {
  const ownedRoot = path.join(root, "healthy");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

  const reports: CleanupFailureReport[] = [];
  const prepared = adoptPreparedLocation(location, ownedRoot, false, (report) =>
    reports.push(report),
  );

  expect(prepared.cleanup()).toBe(true);
  expect(reports).toHaveLength(0);
  expect(fs.existsSync(ownedRoot)).toBe(false);
  // A second cleanup is a no-op once the owner has removed its directory.
  expect(prepared.cleanup()).toBe(true);
  expect(reports).toHaveLength(0);
});

describe.runIf(supportsChmodDenial)("chmod-denied default sink", () => {
  it("uses process.emitWarning as the default sink when no callback is supplied", async () => {
    const ownedRoot = path.join(root, "default-sink");
    const location = path.join(ownedRoot, "database.sqlite");
    await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(location, "snapshot bytes");

    const warnings: string[] = [];
    vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
      warnings.push(warning instanceof Error ? warning.message : warning);
    });

    const prepared = adoptPreparedLocation(location, ownedRoot, false);

    await revokeParentWrite();
    try {
      expect(prepared.cleanup()).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await fs.promises.chmod(root, 0o700);
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(ownedRoot);
    expect(warnings[0]).toContain("SQLite read-only snapshot cleanup failed");
  });
});

it("exposes SnapshotCleanupWarning as a named export for log filtering", () => {
  const warning = new SnapshotCleanupWarning("/tmp/example");
  expect(warning).toBeInstanceOf(Error);
  expect(warning.name).toBe("SnapshotCleanupWarning");
  expect(warning.message).toContain("/tmp/example");
  expect(warning.message).toContain("SQLite read-only snapshot cleanup failed");
});

describe.runIf(supportsChmodDenial)("chmod-denied requireCleanup", () => {
  it("still throws on cleanup failure when requireCleanup is set", async () => {
    const ownedRoot = path.join(root, "required");
    const location = path.join(ownedRoot, "database.sqlite");
    await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(location, "snapshot bytes");

    const prepared = adoptPreparedLocation(location, ownedRoot, true);

    await revokeParentWrite();
    try {
      expect(() => prepared.cleanup()).toThrow(/snapshot cleanup failed/u);
    } finally {
      await fs.promises.chmod(root, 0o700);
    }
  });
});

it("exposes cleanupRoot as the directory cleanup owns", () => {
  const ownedRoot = path.join(root, "explicit-root");
  const location = path.join(ownedRoot, "database.sqlite");
  const prepared = adoptPreparedLocation(location, ownedRoot);
  expect(prepared.cleanupRoot).toBe(ownedRoot);

  // Without an explicit owned root, cleanup owns the directory holding the snapshot.
  const fallback = adoptPreparedLocation(path.join(root, "fallback", "database.sqlite"));
  expect(fallback.cleanupRoot).toBe(path.join(root, "fallback"));
});

it("does not emit a false warning when synchronous cleanup races an in-flight async removal", async () => {
  const ownedRoot = path.join(root, "concurrent");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

  const reports: CleanupFailureReport[] = [];
  const prepared = adoptPreparedLocation(location, ownedRoot, false, (report) =>
    reports.push(report),
  );

  // Start an async removal but do not await it yet.  The synchronous cleanup()
  // sees `pending` and must return false without reporting a failure — the
  // async path reports the actual outcome when it settles.
  const removal = prepared.cleanupAsync();
  // Let the microtask queue drain so the pending promise is set.
  await Promise.resolve();
  expect(prepared.cleanup()).toBe(false);
  expect(reports).toHaveLength(0);

  await removal;
  // The async removal succeeded, so no warning should ever have been emitted.
  expect(reports).toHaveLength(0);
  expect(fs.existsSync(ownedRoot)).toBe(false);
});

it("does not throw when the onCleanupFailure callback itself throws", async () => {
  const ownedRoot = path.join(root, "throwing-callback");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

  const fallbackWarnings: string[] = [];
  vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
    fallbackWarnings.push(warning instanceof Error ? warning.message : warning);
  });
  // Force removal failure via fs.rmSync mock so the callback is exercised on
  // every platform, including root POSIX and Windows (where chmod can't deny).
  vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw new Error("mock removal failure");
  });

  const prepared = adoptPreparedLocation(location, ownedRoot, false, () => {
    throw new Error("callback exploded");
  });

  try {
    // cleanup() must not throw even though the callback throws — the
    // non-throwing contract (requireCleanup=false) must hold.
    expect(prepared.cleanup()).toBe(false);
  } finally {
    vi.restoreAllMocks();
  }

  // The callback failure fell back to process.emitWarning with the cleanup
  // diagnostic, and the callback error itself was also warned.
  expect(fallbackWarnings).toHaveLength(2);
  expect(fallbackWarnings[0]).toContain("SQLite read-only snapshot cleanup failed");
  expect(fallbackWarnings[1]).toContain("callback exploded");
});

it("normalizes non-Error callback failures without throwing", async () => {
  const ownedRoot = path.join(root, "non-error-callback");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

  // Simulate Node's real emitWarning behaviour: it accepts string or Error but
  // throws ERR_INVALID_ARG_TYPE for numbers, null, or plain objects. The fix
  // must normalize the callback error before calling emitWarning.
  const fallbackWarnings: string[] = [];
  vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
    if (typeof warning !== "string" && !(warning instanceof Error)) {
      throw Object.assign(new TypeError("ERR_INVALID_ARG_TYPE"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    fallbackWarnings.push(warning instanceof Error ? warning.message : warning);
  });
  vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw new Error("mock removal failure");
  });

  const prepared = adoptPreparedLocation(location, ownedRoot, false, () => {
    // A non-Error throw (number) must not cause emitWarning to throw
    // ERR_INVALID_ARG_TYPE — it should be normalized to a string warning.
    // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error failures at the cleanup boundary.
    throw 42;
  });

  try {
    // On the pre-fix code, process.emitWarning(42) throws ERR_INVALID_ARG_TYPE,
    // which escapes cleanup() and violates the non-throwing contract.
    expect(prepared.cleanup()).toBe(false);
  } finally {
    vi.restoreAllMocks();
  }

  expect(fallbackWarnings).toHaveLength(2);
  expect(fallbackWarnings[0]).toContain("SQLite read-only snapshot cleanup failed");
  expect(fallbackWarnings[1]).toContain("42");
});
