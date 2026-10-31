import type { ServerResponse } from "node:http";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import { applyAssistantMediaInlinePreviewHeaders } from "./control-ui-csp.js";
import type { RemoteControlUiIngressContext } from "./server/client-identity-types.js";

/**
 * Write the response disposition for an assistant-media delivery.
 *
 * A browser-native PDF preview asks for inline rendering so the sidebar reader
 * shows the payload and keeps the Content-Disposition filename. Only that byte
 * response relaxes the media endpoint's anti-framing baseline; every other
 * response keeps X-Frame-Options: DENY / frame-ancestors 'none'.
 */
export function applyAssistantMediaDisposition(
  res: ServerResponse,
  url: URL,
  filename: string,
  contentType: string,
  ingress?: RemoteControlUiIngressContext,
): void {
  const inline =
    url.searchParams.get("disposition") === "inline" && contentType === "application/pdf";
  if (inline) {
    applyAssistantMediaInlinePreviewHeaders(res, ingress);
  }
  res.setHeader(
    "Content-Disposition",
    buildAssistantMediaContentDisposition(filename, contentType, { inline }),
  );
}
