import {
  type Accessor,
  createMemo,
  createSignal,
  Errored,
  isPending,
  Loading,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { AttachmentPreviewSkeleton, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";
import { createPdfPreviewWorker } from "./chat-pdf-worker.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";
import type { FilePreviewSource } from "./chat-sidebar-content-types.ts";

registerEnglishCatalog(registerChatComposerEnglish);

const PDF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const PDF_PREVIEW_TIMEOUT_MS = 10_000;

/**
 * Bounded read shared by the HTTP-src and file previews: fetch the payload (or the
 * granted file) and validate it fits the preview limit. HTTP srcs only need the
 * validation so the frame can load the real URL and keep its Content-Disposition name.
 */
async function readPreviewSource(
  src: string,
  file: FilePreviewSource | undefined,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  // File previews retain their identity, not an expiring download grant.
  const original = file ? await file.download(signal) : null;
  signal.throwIfAborted();
  if (file && !original) {
    throw new Error("PDF file unavailable");
  }
  const response =
    original && "blob" in original
      ? new Response(original.blob)
      : await fetch(original?.url ?? src, {
          credentials: "same-origin",
          redirect: "error",
          signal,
        });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("PDF attachment unavailable");
  }
  const bytes = await readResponseBytesWithinLimit(response, PDF_PREVIEW_MAX_BYTES);
  if (!bytes) {
    throw new Error("PDF attachment exceeds preview limit");
  }
  return bytes;
}

export function isPdfAttachment(rawMimeType: string, filename: string): boolean {
  const mimeType = rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType === "application/pdf" ||
    ((!mimeType || mimeType === "application/octet-stream") && /\.pdf$/i.test(filename))
  );
}

/**
 * Only a response the Gateway can label `application/pdf` is inlined: that is the
 * one case where the native viewer renders and keeps the Content-Disposition name.
 * A PDF known by filename alone keeps the bounded Blob detour so it still renders.
 */
function servesInlinePdf(rawMimeType: string): boolean {
  return (rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "") === "application/pdf";
}

/** Owns the bounded, browser-native PDF surface for same-origin attachments. */
export function ChatPdfPreview(props: {
  src: string;
  sourceIdentity: string;
  label: string;
  mimeType: string;
  sizeBytes?: number;
  file?: FilePreviewSource;
}) {
  // A new ticket keeps its reader; a different attachment or missing source retires it.
  const source = createMemo(
    () =>
      [
        props.sourceIdentity,
        props.sourceIdentity ? undefined : props.src,
        props.sizeBytes,
        Boolean(props.src || props.file),
        props.file?.download,
      ] as const,
    { equals: (before, next) => before.every((value, index) => Object.is(value, next[index])) },
  );
  const unavailable = () => (
    <div class="sidebar-attachment-preview__unavailable" role="alert">
      {t("chat.attachments.previewUnavailable")}
      <Show
        when={props.file}
        fallback={
          <CompactAttachmentCard
            kind="document"
            label={props.label}
            mimeType={props.mimeType}
            sizeBytes={props.sizeBytes}
            downloadHref={safeAttachmentHref(props.src) ?? undefined}
          />
        }
      >
        {(file) => (
          <FileDownloadButton
            scopeKey={props.sourceIdentity}
            download={file().download}
            class="btn btn--sm"
            showLabel
          />
        )}
      </Show>
    </div>
  );
  const readBounded = () =>
    createMemo<{ ok: true; bytes: ArrayBuffer } | { ok: false; cause: unknown }>(
      async () => {
        const src = props.src;
        const file = props.file;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PDF_PREVIEW_TIMEOUT_MS);
        // This cleanup belongs to the tracked read, so replacement aborts transport immediately.
        onCleanup(() => {
          controller.abort();
          clearTimeout(timeout);
        });
        try {
          const bytes = await readPreviewSource(src, file, controller.signal);
          return { ok: true, bytes };
        } catch (cause) {
          // Commit failure so a later ticket cannot revive the previously successful reader.
          return { ok: false, cause };
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        equals: (before, next) => {
          if (!before.ok || !next.ok || before.bytes.byteLength !== next.bytes.byteLength) {
            return false;
          }
          const right = new Uint8Array(next.bytes);
          return new Uint8Array(before.bytes).every((byte, index) => byte === right[index]);
        },
      },
    );
  const renderFilePreview = () => {
    const result = readBounded();
    const bytes = () => {
      const value = result();
      return value.ok ? value.bytes : undefined;
    };
    const error = () => {
      const value = result();
      if (!value.ok) {
        throw value.cause;
      }
      return null;
    };
    // The reader survives changed bytes; only its settled Blob URL changes lifetime.
    const renderFrame = (value: Accessor<ArrayBuffer>) => {
      const [url, setUrl] = createSignal<string>();
      const [reader, setReader] = createSignal<ReturnType<typeof createPdfPreviewWorker>>();
      const [failed, setFailed] = createSignal(false);
      onSettled(() => {
        try {
          const next = createPdfPreviewWorker(setUrl, () => setFailed(true));
          setReader(next);
          return () => next.dispose();
        } catch {
          setFailed(true);
          return undefined;
        }
      });
      return (
        <Show when={!failed()} fallback={unavailable()}>
          <Show when={reader()} keyed>
            {(current) => (
              <Show when={value()} keyed>
                {(content) => {
                  onSettled(() => current.show(content));
                  return null;
                }}
              </Show>
            )}
          </Show>
          <Show when={url()} fallback={<AttachmentPreviewSkeleton />}>
            <iframe
              class="sidebar-pdf-preview__frame"
              title={props.label}
              src={url()}
              referrerpolicy="no-referrer"
            />
          </Show>
        </Show>
      );
    };
    return (
      <Loading fallback={<AttachmentPreviewSkeleton />}>
        <Show
          when={result().ok || !isPending(() => result())}
          fallback={<AttachmentPreviewSkeleton />}
        >
          <Show when={bytes()}>{renderFrame}</Show>
          <Errored fallback={(_error) => unavailable()}>{error()}</Errored>
        </Show>
      </Loading>
    );
  };
  // Same-origin HTTP srcs carry a Content-Disposition filename, so load the real
  // URL directly (not an anonymous Blob). The frame URL tracks props.src reactively
  // so a renewed media ticket replaces the stale, expiring URL. The renewal is a
  // visible frame reload even for unchanged bytes, which is the accepted cost of
  // never leaving an expired ticket behind. The inline disposition makes the
  // browser-native PDF viewer render the payload while keeping the filename. A
  // bounded read validates reachability before the first frame and re-validates
  // each renewal; a failed renewal retires the stale reader so a later valid
  // ticket can recover it.
  const inlinePreviewUrl = () => {
    const src = props.src;
    const sep = src.includes("?") ? "&" : "?";
    return `${src}${sep}disposition=inline`;
  };
  const renderDirectPreview = () => {
    // The bounded read tracks props.src, so a renewed ticket re-validates instead
    // of pinning the expiring URL. A failed renewal settles to `ok: false` and
    // retires the stale reader; a later valid ticket recovers it.
    const result = createMemo<{ ok: true } | { ok: false; cause: unknown }>(async () => {
      const src = props.src;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PDF_PREVIEW_TIMEOUT_MS);
      onCleanup(() => {
        controller.abort();
        clearTimeout(timeout);
      });
      try {
        await readPreviewSource(src, undefined, controller.signal);
        return { ok: true };
      } catch (cause) {
        return { ok: false, cause };
      } finally {
        clearTimeout(timeout);
      }
    });
    const error = () => {
      const value = result();
      if (!value.ok) {
        throw value.cause;
      }
      return null;
    };
    return (
      <Loading fallback={<AttachmentPreviewSkeleton />}>
        <Show
          when={result().ok || !isPending(() => result())}
          fallback={<AttachmentPreviewSkeleton />}
        >
          <Show when={result().ok}>
            <iframe
              class="sidebar-pdf-preview__frame"
              title={props.label}
              src={inlinePreviewUrl()}
              referrerpolicy="no-referrer"
            />
          </Show>
          <Errored fallback={(_error) => unavailable()}>{error()}</Errored>
        </Show>
      </Loading>
    );
  };
  const renderPreview = (input: ReturnType<typeof source>) => {
    const sizeBytes = input[2];
    if (!input[3]) {
      return <AttachmentPreviewSkeleton />;
    }
    if (sizeBytes !== undefined && sizeBytes > PDF_PREVIEW_MAX_BYTES) {
      return unavailable();
    }
    // The Gateway only inlines responses it labels application/pdf. File previews
    // and filename-only PDFs (empty/octet-stream MIME) keep the bounded Blob detour.
    if (props.file || !servesInlinePdf(props.mimeType)) {
      return renderFilePreview();
    }
    return renderDirectPreview();
  };
  return (
    <openclaw-chat-pdf-preview style={{ display: "contents" }}>
      <div class="sidebar-pdf-preview" aria-label={props.label}>
        <div class="sidebar-pdf-preview__surface">
          <Show when={source()} keyed>
            {renderPreview}
          </Show>
        </div>
      </div>
    </openclaw-chat-pdf-preview>
  );
}
