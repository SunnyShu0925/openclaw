import type { ChatImageRenditionWidth } from "../../../../../src/shared/chat-image-renditions.js";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import {
  buildAssistantMediaUrl,
  type AssistantMediaContext,
} from "../../../app/assistant-media.ts";

export function isLocalAssistantAttachmentSource(source: string): boolean {
  const trimmed = source.trim();
  if (/^\/(?:__openclaw__|media|api\/chat\/media\/outgoing)\//.test(trimmed)) {
    return false;
  }
  return (
    isCanonicalInboundMediaSource(trimmed) ||
    /^file:/iu.test(trimmed) ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    (Boolean(trimmed) && !/^[a-z][a-z0-9+.-]*:/iu.test(trimmed))
  );
}

export function isCanonicalInboundMediaSource(source: string): boolean {
  // Match the raw one-segment form first; URL parsing would erase dot segments.
  const match = /^media:\/\/inbound\/([^/?#]+)$/i.exec(source.trim());
  if (!match?.[1]) {
    return false;
  }
  try {
    const id = decodeURIComponent(match[1]);
    return (
      id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\") && !id.includes("\0")
    );
  } catch {
    return false;
  }
}

export function buildAssistantAttachmentUrl(
  source: string,
  resourceBasePath?: string,
  mediaTicket?: string | null,
  context?: AssistantMediaContext,
  filename?: string,
  variant?: "thumbnail",
  previewWidth: ChatImageRenditionWidth = 960,
  inlinePdfPreview = false,
): string {
  if (!isLocalAssistantAttachmentSource(source)) {
    return source;
  }
  const url = buildAssistantMediaUrl(source, resourceBasePath, mediaTicket, context, filename);
  const preview =
    variant === "thumbnail" && isCanonicalInboundMediaSource(source)
      ? `${url}&variant=thumbnail&width=${previewWidth}&v=4`
      : url;
  // Only this endpoint answers `disposition=inline` with a frameable PDF response,
  // so the caller that knows the document requests it here. It serves local file
  // references; a source that is itself a server route (an artifact or preview URL)
  // is not readable there, so it must not claim the capability. Other media routes
  // keep their own attachment contract and stay on the bounded Blob reader.
  const servesInline = inlinePdfPreview && !/^\/(?:api|__openclaw__)\//u.test(source.trim());
  return servesInline ? `${preview}&disposition=inline` : preview;
}

export function applyResourceBasePath(
  source: string,
  resourceBasePath: string | undefined,
): string {
  if (!source.startsWith("/") || source.startsWith("//")) {
    return source;
  }
  try {
    const parsed = new URL(source, window.location.origin);
    const basePath = normalizeBasePath(resourceBasePath ?? "");
    const pathname =
      basePath && parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)
        ? `${basePath}${parsed.pathname}`
        : parsed.pathname;
    return `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return source;
  }
}
