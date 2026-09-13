import { formatSqliteErrorCodeSuffix } from "../infra/sqlite-error-diagnostics.js";
import { SnapshotCleanupWarning } from "../infra/sqlite-readonly-location-cleanup.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

const DATABASE_VERIFY_CHILD_ARG = "--openclaw-database-verify-child";

export type OpenClawDatabaseVerifyTarget = {
  path: string;
  kind: "agent" | "state";
  label: string;
};

export type OpenClawDatabaseVerifyResult = {
  path: string;
  ok: boolean;
  error?: string;
  terminal?: boolean;
  warnings?: string[];
};

function isVerifyTarget(value: unknown): value is OpenClawDatabaseVerifyTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const target = value as Record<string, unknown>;
  return (
    typeof target.path === "string" &&
    (target.kind === "agent" || target.kind === "state") &&
    typeof target.label === "string"
  );
}

function formatVerifyError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `${message}${formatSqliteErrorCodeSuffix(error)}`;
}

async function verifyOpenClawDatabase(
  target: OpenClawDatabaseVerifyTarget,
): Promise<OpenClawDatabaseVerifyResult> {
  const [sqlite, integrity, location] = await Promise.all([
    import("../infra/node-sqlite.js"),
    import("../infra/sqlite-integrity.js"),
    import("../infra/sqlite-readonly-location.js"),
  ]);
  let cleanup: (() => Promise<boolean>) | undefined;
  let database: import("node:sqlite").DatabaseSync | undefined;
  // Capture only snapshot-cleanup warnings from this target's lifecycle so they
  // are attributed to the correct database. Unrelated Node warnings are left alone.
  const targetWarnings: string[] = [];
  const originalEmitWarning = process.emitWarning.bind(process);
  // Intercept only SnapshotCleanupWarning instances; pass everything else through
  // to the original emitWarning unchanged via Reflect.apply.
  const interceptWarning: typeof process.emitWarning = (...args: unknown[]) => {
    const [warning] = args;
    if (warning instanceof SnapshotCleanupWarning) {
      targetWarnings.push(warning.message);
    } else {
      Reflect.apply(originalEmitWarning, process, args);
    }
  };
  process.emitWarning = interceptWarning;
  try {
    let result = await (async (): Promise<OpenClawDatabaseVerifyResult> => {
      try {
        const prepared = await location.prepareSqliteReadOnlyLocationInProcess(target.path);
        cleanup = prepared.cleanupAsync;
        database = sqlite.openNodeSqliteDatabase(prepared.location, {
          readOnly: true,
        });
        database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
        integrity.assertSqliteIntegrity(database, target.label);
        return { path: target.path, ok: true };
      } catch (error) {
        const terminal = error instanceof Error && integrity.isTerminalSqliteIntegrityError(error);
        return {
          path: target.path,
          ok: false,
          error: formatVerifyError(error),
          terminal,
        };
      }
    })();
    try {
      database?.close();
    } catch (error) {
      if (result.ok) {
        result = {
          path: target.path,
          ok: false,
          error: formatVerifyError(error),
          terminal: false,
        };
      }
    } finally {
      await cleanup?.();
    }
    if (targetWarnings.length > 0) {
      result.warnings = [...(result.warnings ?? []), ...targetWarnings];
    }
    return result;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/** Verify database files serially so large agent scans never compete for I/O. */
export async function verifyOpenClawDatabases(
  targets: readonly OpenClawDatabaseVerifyTarget[],
): Promise<OpenClawDatabaseVerifyResult[]> {
  const results: OpenClawDatabaseVerifyResult[] = [];
  for (const target of targets) {
    results.push(await verifyOpenClawDatabase(target));
  }
  return results;
}

// This module is also imported for its verifier function. Only the dedicated
// child may consume and disconnect the process-wide IPC channel.
const sendToParent =
  process.argv[2] === DATABASE_VERIFY_CHILD_ARG ? process.send?.bind(process) : undefined;
if (sendToParent) {
  // The child's stderr is ignored (stdio: ["ignore","ignore","ignore","ipc"]),
  // so cleanup warnings would vanish. Each verifyOpenClawDatabase call captures
  // its own SnapshotCleanupWarning instances and attaches them to that target's
  // result, so the parent can log them with the correct database path.
  process.once("message", (message: unknown) => {
    void (async () => {
      try {
        const targets = Array.isArray(message) ? message.filter(isVerifyTarget) : [];
        const results = await verifyOpenClawDatabases(targets);
        await new Promise<void>((resolve, reject) => {
          sendToParent(results, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      } catch {
        process.exitCode = 1;
      } finally {
        process.disconnect?.();
      }
    })();
  });
}
