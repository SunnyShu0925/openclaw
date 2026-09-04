/**
 * Shared invalid-config formatting, logging, and error helpers for config reads and mutations.
 * All terminal-facing text is sanitized here so callers can reuse the same failure surface.
 */
import type { DedupeCache } from "../infra/dedupe.js";
import { extractErrorCode } from "../infra/errors.js";
import { formatConfigIssueLines } from "./issue-format.js";

/** Minimal validation issue shape accepted from schema and mutation validation paths. */
type ConfigValidationIssueLike = {
  path: string;
  message: string;
};

/** Formats validation issues as terminal-safe bullet lines for config load failures. */
export function formatInvalidConfigDetails(issues: ConfigValidationIssueLike[]): string {
  return formatConfigIssueLines(issues, "-", { normalizeRoot: true }).join("\n");
}

/** Builds the one-line invalid-config prefix plus preformatted validation details. */
function formatInvalidConfigLogMessage(configPath: string, details: string): string {
  return `Invalid config at ${configPath}:\n${details}`;
}

/** Logs an invalid config message once per path during a load sequence. */
function logInvalidConfigOnce(params: {
  configPath: string;
  details: string;
  logger: Pick<typeof console, "error">;
  loggedConfigPaths: DedupeCache;
}): void {
  if (params.loggedConfigPaths.check(params.configPath)) {
    // Avoid repeating the same invalid config block when multiple callers observe the same path.
    return;
  }
  params.logger.error(formatInvalidConfigLogMessage(params.configPath, params.details));
}

/** Creates the tagged error shape used by callers that need details after catch.
 * Does not log — callers that want a diagnostic must use {@link throwInvalidConfig} or log themselves. */
export function createInvalidConfigError(
  configPath: string,
  details: string,
  options: { recovery?: "doctor" | "manual" } = {},
): Error {
  const error = new Error(`Invalid config at ${configPath}:\n${details}`);
  // Keep metadata non-class-based so cross-module callers can inspect plain Error instances.
  error.name = "InvalidConfigError";
  const tagged = error as {
    code?: "INVALID_CONFIG";
    details?: string;
    recovery?: "doctor" | "manual";
    diagnosticEmitted?: boolean;
  };
  tagged.code = "INVALID_CONFIG";
  tagged.details = details;
  tagged.recovery = options.recovery ?? "doctor";
  // Default: no diagnostic has been emitted for this error. Only throwInvalidConfig
  // (which logs before throwing) sets this to true, letting downstream catch blocks
  // distinguish already-logged errors from silent ones.
  tagged.diagnosticEmitted = false;
  return error;
}

export function isInvalidConfigError(err: unknown): err is Error & {
  code: "INVALID_CONFIG";
  details?: string;
  recovery?: "doctor" | "manual";
  diagnosticEmitted?: boolean;
} {
  return extractErrorCode(err) === "INVALID_CONFIG";
}

export function isDoctorRecoverableInvalidConfigError(err: unknown): boolean {
  return isInvalidConfigError(err) && err.recovery !== "manual";
}

/** Logs and throws the standard invalid-config error for a validation result. */
export function throwInvalidConfig(params: {
  configPath: string;
  issues: ConfigValidationIssueLike[];
  logger: Pick<typeof console, "error">;
  loggedConfigPaths: DedupeCache;
}): never {
  const details = formatInvalidConfigDetails(params.issues);
  logInvalidConfigOnce({
    configPath: params.configPath,
    details,
    logger: params.logger,
    loggedConfigPaths: params.loggedConfigPaths,
  });
  const error = createInvalidConfigError(params.configPath, details);
  // SAFETY: createInvalidConfigError constructs the error with this optional field; mutating it here is safe.
  (error as { diagnosticEmitted?: boolean }).diagnosticEmitted = true;
  throw error;
}
