import { pathScope } from "openclaw/plugin-sdk/security-runtime";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ensureOutputDirectory } from "../output-directories.js";
import type { BrowserResponse } from "./types.js";

/** Resolve a writable output path or send a 400 JSON response on scope errors. */
export async function resolveWritableOutputPathOrRespond(params: {
  res: BrowserResponse;
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
  ensureRootDir?: boolean;
}): Promise<string | null> {
  if (params.ensureRootDir) {
    await ensureOutputDirectory(params.rootDir);
  }
  // Preserve the operator's literal spelling. pathScope().writable() trims its
  // requestedPath input, so we route the literal destination through the
  // empty-request branch as defaultName, which is never trimmed. This reuses the
  // shared fs-safe writable admission (canonical-parent containment, regular-file
  // requirement, and Windows namespace-alias rejection) on the literal spelling
  // instead of duplicating its filesystem policy, matching the downstream
  // literal-destination writer (GHSA-XWJM-J929-XQ7C containment gate).
  const literalPath = readNonBlankString(params.requestedPath) ?? params.defaultFileName;
  if (!literalPath) {
    params.res.status(400).json({ error: "path is required" });
    return null;
  }
  const result = await pathScope(params.rootDir, { label: params.scopeLabel }).writable("", {
    defaultName: literalPath,
  });
  if (!result.ok) {
    params.res.status(400).json({ error: result.error });
    return null;
  }
  return result.path;
}
