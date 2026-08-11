// Media reference helpers resolve media refs to file, URL, or inline payloads.
import fs from "node:fs/promises";
import path from "node:path";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { resolveUserPath } from "../utils.js";
import { getMediaDir, resolveMediaBufferPath } from "./store.js";

type MediaReferenceErrorCode = "invalid-path" | "path-not-allowed";

/** Error raised when a media reference cannot be mapped to an allowed local media file. */
export class MediaReferenceError extends Error {
  code: MediaReferenceErrorCode;

  constructor(code: MediaReferenceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "MediaReferenceError";
  }
}

type InboundMediaReference = {
  id: string;
  normalizedSource: string;
  physicalPath: string;
  sourceType: "uri" | "path";
};

type InboundMediaUri = {
  id: string;
  normalizedSource: string;
};

/** Strips legacy MEDIA: prefixes while preserving canonical media:// references. */
export function normalizeMediaReferenceSource(source: string): string {
  const trimmed = source.trim();
  if (/^media:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

type MediaReferenceSourceInfo = {
  hasScheme: boolean;
  hasUnsupportedScheme: boolean;
  isDataUrl: boolean;
  isFileUrl: boolean;
  isHttpUrl: boolean;
  isMediaStoreUrl: boolean;
  looksLikeWindowsDrivePath: boolean;
};

/** Classifies media reference schemes before local resolution or sandbox rewriting. */
export function classifyMediaReferenceSource(
  source: string,
  options?: { allowDataUrl?: boolean },
): MediaReferenceSourceInfo {
  const allowDataUrl = options?.allowDataUrl ?? true;
  const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(source);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(source);
  const isFileUrl = /^file:/i.test(source);
  const isHttpUrl = hasHttpUrlPrefix(source);
  const isDataUrl = /^data:/i.test(source);
  const isMediaStoreUrl = /^media:\/\//i.test(source);
  const hasUnsupportedScheme =
    hasScheme &&
    !looksLikeWindowsDrivePath &&
    !isFileUrl &&
    !isHttpUrl &&
    !isMediaStoreUrl &&
    !(allowDataUrl && isDataUrl);
  return {
    hasScheme,
    hasUnsupportedScheme,
    isDataUrl,
    isFileUrl,
    isHttpUrl,
    isMediaStoreUrl,
    looksLikeWindowsDrivePath,
  };
}

function maybeLocalPathFromSource(source: string): string | null {
  if (/^file:/i.test(source)) {
    try {
      return safeFileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith("~")) {
    return resolveUserPath(source);
  }
  if (path.isAbsolute(source)) {
    return source;
  }
  return null;
}

function relativePathEscapesBase(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    path.isAbsolute(relativePath)
  );
}

async function resolvePathForContainment(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/** Parses canonical inbound media-store URIs and rejects nested or cross-bucket references. */
export function parseInboundMediaUri(source: string): InboundMediaUri | null {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!/^media:\/\//i.test(normalizedSource)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedSource);
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  if (parsed.hostname !== "inbound") {
    throw new MediaReferenceError(
      "path-not-allowed",
      `Unsupported media URI location: ${parsed.hostname || "(missing)"}`,
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
  }

  let id: string;
  try {
    id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  const invalidId = !id || id === "." || id === "..";
  if (invalidId || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
  }

  return {
    id,
    normalizedSource,
  };
}

/**
 * Rewrites a host-local managed inbound file path to its canonical `media://inbound/<id>` URI.
 *
 * Chat-history persistence may store the physical absolute path of a managed inbound
 * media file (e.g. `<stateDir>/media/inbound/<id>`) on the `__openclaw.media[].path` fact.
 * The privacy projection must not expose that host path, but erasing it entirely leaves
 * the UI with no renderable reference. This helper returns the canonical inbound URI the
 * UI already loads through the authenticated assistant-media route when — and only when —
 * the path is provably inside the configured inbound store; every other path returns
 * `undefined` so the caller falls back to redaction.
 *
 * Safety: containment is established by resolving the candidate against
 * `getMediaDir()/inbound` and requiring a single non-escaping relative component, mirroring
 * the ownership check in `resolveInboundMediaReference` (which is async because it also
 * realpath-resolves; the projection runs synchronously and accepts the same direct-path
 * contract). A lookalike path such as `/tmp/media/inbound/<id>` is not inside the
 * configured store and is redacted, so it cannot be promoted to an authenticated media
 * capability. Malformed percent-encoded ids are also redacted: `parseInboundMediaUri`
 * throws on invalid escapes, so failures here are caught and mapped to `undefined`.
 */
export function buildInboundMediaUriFromPath(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed) {
    return undefined;
  }
  const localPath = maybeLocalPathFromSource(trimmed);
  if (!localPath) {
    return undefined;
  }
  const inboundDir = path.resolve(getMediaDir(), "inbound");
  const rel = path.relative(inboundDir, path.resolve(localPath));
  // The inbound id must be a single path component that does not escape the store bucket;
  // reject traversal, nested segments, and absolute/empty results.
  if (!rel || relativePathEscapesBase(rel) || rel.includes(path.sep) || rel.includes("\\")) {
    return undefined;
  }
  const candidate = `media://inbound/${rel}`;
  try {
    const parsed = parseInboundMediaUri(candidate);
    return parsed?.normalizedSource;
  } catch {
    // Malformed percent-encoded ids (e.g. a stray `%`) make the URI decoder throw;
    // redact instead of propagating the failure into the shared history projection.
    return undefined;
  }
}

async function resolveInboundMediaUri(
  normalizedSource: string,
): Promise<InboundMediaReference | null> {
  const uri = parseInboundMediaUri(normalizedSource);
  if (!uri) {
    return null;
  }
  return {
    ...uri,
    physicalPath: await resolveInboundMediaPath(uri.id, uri.normalizedSource),
    sourceType: "uri",
  };
}

/** Rewrites inbound media-store URIs to sandbox-relative paths for staged agent inputs. */
export function resolveMediaReferenceSandboxPath(
  source: string,
  inboundDir = "media/inbound",
): { resolved: string; rewrittenFrom?: string } {
  const normalizedSource = normalizeMediaReferenceSource(source);
  const uri = parseInboundMediaUri(normalizedSource);
  if (!uri) {
    return { resolved: normalizedSource };
  }
  return {
    resolved: path.posix.join(inboundDir.replace(/\\/g, "/"), uri.id),
    rewrittenFrom: uri.normalizedSource,
  };
}

/** Resolves inbound media:// URIs or first-level inbound file paths to concrete store files. */
export async function resolveInboundMediaReference(
  source: string,
): Promise<InboundMediaReference | null> {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!normalizedSource) {
    return null;
  }

  const uriSource = await resolveInboundMediaUri(normalizedSource);
  if (uriSource) {
    return uriSource;
  }

  const localPath = maybeLocalPathFromSource(normalizedSource);
  if (!localPath) {
    return null;
  }

  const rawInboundDir = path.resolve(getMediaDir(), "inbound");
  const rawResolvedPath = path.resolve(localPath);
  const rawRel = path.relative(rawInboundDir, rawResolvedPath);
  // Realpath fallback catches symlinks and moved state dirs before accepting direct paths.
  const rel =
    rawRel && !relativePathEscapesBase(rawRel)
      ? rawRel
      : path.relative(
          await resolvePathForContainment(rawInboundDir),
          await resolvePathForContainment(localPath),
        );
  if (!rel || relativePathEscapesBase(rel) || rel.includes(path.sep)) {
    return null;
  }

  return {
    id: rel,
    normalizedSource,
    physicalPath: await resolveInboundMediaPath(rel, normalizedSource),
    sourceType: "path",
  };
}

/** Resolves a media reference while preserving whether it belongs to the inbound store. */
export async function resolveMediaReferenceLocalPathInfo(source: string) {
  const normalizedSource = normalizeMediaReferenceSource(source);
  const inboundReference = await resolveInboundMediaReference(normalizedSource);
  return inboundReference
    ? { kind: "inbound" as const, path: inboundReference.physicalPath }
    : { kind: "local" as const, path: normalizedSource };
}

/** Converts inbound media references for callers that need a direct local file path. */
export async function resolveMediaReferenceLocalPath(source: string): Promise<string> {
  return (await resolveMediaReferenceLocalPathInfo(source)).path;
}

async function resolveInboundMediaPath(id: string, source: string): Promise<string> {
  try {
    return await resolveMediaBufferPath(id, "inbound");
  } catch (err) {
    throw new MediaReferenceError(
      "invalid-path",
      err instanceof Error ? err.message : `Invalid media reference: ${source}`,
      { cause: err },
    );
  }
}
