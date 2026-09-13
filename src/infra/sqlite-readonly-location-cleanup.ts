// Owner-level diagnostic for SQLite read-only snapshot cleanup failures.
// Kept separate so adoptPreparedLocation stays under the file line cap and the
// warning shape (Error subclass + default sink) lives next to its type.

// A non-throwing cleanup-failure report emitted once per owner; a successful
// read is never turned into a failure by temp-file cleanup.
export type CleanupFailureReport = {
  cleanupRoot: string;
};

export class SnapshotCleanupWarning extends Error {
  constructor(cleanupRoot: string) {
    super(
      `SQLite read-only snapshot cleanup failed: ${cleanupRoot}. Check directory permissions and available storage before retrying.`,
    );
    this.name = "SnapshotCleanupWarning";
  }
}

// Record a cleanup failure through the consumer's callback when supplied, or a
// non-throwing process warning otherwise (mirrors sqlite-coordinator's idle-close
// diagnostic). The owner calls this at most once per failure; the exit handler
// still retries removal of the private copy.
export function emitSnapshotCleanupFailure(
  report: CleanupFailureReport,
  onCleanupFailure?: (report: CleanupFailureReport) => void,
): void {
  if (onCleanupFailure) {
    try {
      onCleanupFailure(report);
    } catch (callbackError) {
      // The diagnostic callback must never turn a successful read into a
      // failure (requireCleanup=false contract). Fall back to the default sink.
      // Normalize the callback error: emitWarning rejects non-string/Error
      // values (numbers, null, plain objects) with ERR_INVALID_ARG_TYPE.
      const normalized =
        callbackError instanceof Error ? callbackError : new Error(String(callbackError));
      process.emitWarning(new SnapshotCleanupWarning(report.cleanupRoot));
      process.emitWarning(normalized);
    }
    return;
  }
  process.emitWarning(new SnapshotCleanupWarning(report.cleanupRoot));
}
