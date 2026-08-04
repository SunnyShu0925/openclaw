/**
 * Non-executing structural validation for manual exec secret-provider command
 * paths. Shares the exact trust rules used by startup activation so a
 * candidate configuration cannot pass schema/write validation and then fail
 * gateway cold start (see #117051).
 */
import path from "node:path";
import { FsSafeError } from "../infra/fs-safe.js";
import { inspectPathPermissions, safeStat } from "../security/audit-fs.js";
import { isPathInside } from "../security/scan-paths.js";
import { resolveUserPath } from "../utils.js";

const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePathname(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

async function readFileStatOrThrow(pathname: string, label: string) {
  const stat = await safeStat(pathname);
  if (!stat.ok) {
    throw new Error(`${label} is not readable: ${pathname}`);
  }
  if (stat.isDir) {
    throw new Error(`${label} must be a file: ${pathname}`);
  }
  return stat;
}

type ExecProviderCommandPathValidationParams = {
  command: string;
  label: string;
  trustedDirs?: string[];
};

/**
 * Validates a manual exec provider command path without executing it. Mirrors
 * the current startup activation rules exactly: absolute path, non-symlink,
 * optional trusted-directory containment, non-writable-by-others permissions,
 * current-user ownership, and Windows ACL availability. Kept at parity with
 * `resolve.ts` cold-start activation so the validator never blocks a command
 * the running gateway would already accept (see #117128).
 */
export async function assertSecureExecCommandPath(
  params: ExecProviderCommandPathValidationParams,
): Promise<string> {
  const targetPath = resolveUserPath(params.command);
  if (!isAbsolutePathname(targetPath)) {
    throw new Error(`${params.label} must be an absolute path.`);
  }

  const effectivePath = targetPath;
  const stat = await readFileStatOrThrow(effectivePath, params.label);
  if (stat.isSymlink) {
    throw new Error(`${params.label} must not be a symlink: ${effectivePath}`);
  }

  if (params.trustedDirs && params.trustedDirs.length > 0) {
    const trusted = params.trustedDirs.map((entry) => resolveUserPath(entry));
    const inTrustedDir = trusted.some((dir) => isPathInside(dir, effectivePath));
    if (!inTrustedDir) {
      throw new Error(`${params.label} is outside trustedDirs: ${effectivePath}`);
    }
  }

  const perms = await inspectPathPermissions(effectivePath);
  if (!perms.ok) {
    throw new Error(`${params.label} permissions could not be verified: ${effectivePath}`);
  }
  if (perms.worldWritable || perms.groupWritable) {
    throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
  }

  if (process.platform === "win32" && perms.source === "unknown") {
    // Preserve the permission-unverified FsSafeError shape so the resolver maps
    // this to SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE (matching the original
    // assertSecurePath semantics); a plain Error would degrade to
    // SECRET_PROVIDER_UNAVAILABLE and lose the Windows fail-closed diagnostic.
    throw new FsSafeError(
      "permission-unverified",
      `${params.label} ACL verification is unavailable on Windows for ${effectivePath}. OpenClaw fails closed when command-path permissions cannot be verified; move the command to a path whose ACLs OpenClaw can verify. There is no provider-level bypass.`,
    );
  }

  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new Error(
        `${params.label} must be owned by the current user (uid=${uid}): ${effectivePath}`,
      );
    }
  }
  return effectivePath;
}
