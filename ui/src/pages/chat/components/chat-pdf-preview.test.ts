/* @vitest-environment jsdom */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "./chat-detail-panel.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const PDF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const source = "/__openclaw__/assistant-media?mediaTicket=pdf-preview";

async function mountAttachment(
  overrides: Partial<Extract<SidebarContent, { kind: "attachment" }>> = {},
) {
  const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
    content: Extract<SidebarContent, { kind: "attachment" }>;
    updateComplete: Promise<unknown>;
  };
  panel.content = {
    kind: "attachment",
    attachmentKind: "document",
    title: "brief.pdf",
    src: source,
    mimeType: "application/pdf",
    ...overrides,
  };
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

const workerProgram = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../public/pdf-preview-worker.js",
  ),
  "utf8",
);

function stubObjectUrls() {
  // jsdom has no Worker. Keep its URL API separate: reverting to app-created PDF URLs must fail.
  const createObjectURL = vi.fn(() => `blob:${location.origin}/pdf-preview`);
  const revokeObjectURL = vi.fn();
  class TestWorker extends EventTarget {
    stopped = false;
    receive?: (event: { data: unknown }) => void;
    realm: {
      addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
      postMessage(data: unknown): void;
      close(): void;
    } = {
      addEventListener: (_type, listener) => {
        this.receive = listener;
      },
      postMessage: (data: unknown) => {
        void Promise.resolve().then(() => {
          if (!this.stopped) {
            this.dispatchEvent(new MessageEvent("message", { data }));
          }
        });
      },
      close: () => {},
    };
    constructor() {
      super();
      vm.runInNewContext(workerProgram, {
        self: this.realm,
        URL: { createObjectURL, revokeObjectURL },
        Blob,
        ArrayBuffer,
      });
    }
    postMessage(data: unknown) {
      void Promise.resolve().then(() => {
        if (!this.stopped) {
          this.receive?.({ data });
        }
      });
    }
    terminate() {
      this.stopped = true;
    }
  }
  vi.stubGlobal("Worker", TestWorker);
  class TestURL extends URL {}
  Object.defineProperty(TestURL, "createObjectURL", {
    value: () => {
      throw new Error("The PDF preview must not create its URL in the app document realm");
    },
  });
  Object.defineProperty(TestURL, "revokeObjectURL", { value: revokeObjectURL });
  vi.stubGlobal("URL", TestURL);
  return { createObjectURL, revokeObjectURL };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["metadata", "timeout"] as const)("declines a PDF after %s rejection", async (failure) => {
  const fetchMock = vi.fn<typeof fetch>();
  if (failure === "timeout") {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("Aborted", "AbortError")),
              );
            },
          }),
        ),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({
    sizeBytes: failure === "metadata" ? PDF_PREVIEW_MAX_BYTES + 1 : undefined,
  });
  if (failure === "timeout") {
    await vi.advanceTimersByTimeAsync(10_000);
  }
  await vi.waitFor(() => expect(panel.textContent).toContain("Preview unavailable"));
  expect(panel.querySelector("iframe")).toBeNull();
  if (failure === "metadata") {
    expect(fetchMock).not.toHaveBeenCalled();
    const download = panel.querySelector<HTMLAnchorElement>("a[download]");
    expect(download?.getAttribute("href")).toBe(source);
    expect(download?.download).toBe("brief.pdf");
  }
});

it("aborts an interrupted PDF load and reloads it after reconnect", async () => {
  const objectUrls = stubObjectUrls();
  const download = vi.fn();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    )
    .mockResolvedValueOnce(new Response("%PDF-1.7"));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({ sizeBytes: 8_231 });

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  panel.remove();
  await waitForSolid(() => expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(download).not.toHaveBeenCalled();
  expect(objectUrls.createObjectURL).not.toHaveBeenCalled();
  expect(objectUrls.revokeObjectURL).not.toHaveBeenCalled();
  expect(panel.querySelector("iframe")?.getAttribute("src")).toBe(
    "/__openclaw__/assistant-media?mediaTicket=pdf-preview&disposition=inline",
  );
  expect(panel.querySelector("iframe")).toHaveProperty("title", "brief.pdf");
  expect(fetchMock).toHaveBeenCalledWith(
    source,
    expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
  );
});

it.each(["oversized", "read failure", "grant failure"] as const)(
  "retains a fresh file download after PDF %s",
  async (failure) => {
    const download = vi.fn(async () => ({ url: source, filename: "brief.pdf" }));
    if (failure === "grant failure") {
      download.mockRejectedValueOnce(new Error("File unavailable"));
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const panel = await mountAttachment({
      src: undefined,
      sourceIdentity: "session-file:brief",
      sizeBytes: failure === "oversized" ? PDF_PREVIEW_MAX_BYTES + 1 : 100,
      file: { path: "brief.pdf", download },
    });
    await waitForSolid(() => expect(panel.querySelector("[role=alert]")).not.toBeNull());
    expect(panel.querySelector("iframe")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(failure === "read failure" ? 1 : 0);
    expect(download).toHaveBeenCalledTimes(failure === "oversized" ? 0 : 1);
    // Explicit download reauthorizes instead of reusing the failed/expired preview grant.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const button = panel.querySelector<HTMLButtonElement>("[role=alert] button");
    expect(button).not.toBeNull();
    button!.click();
    await waitForSolid(() =>
      expect(download).toHaveBeenCalledTimes(failure === "oversized" ? 1 : 2),
    );
  },
);

it("retires file PDF bytes and pending grants on replacement and closure", async () => {
  const urls = stubObjectUrls();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7 original"));
  vi.stubGlobal("fetch", fetcher);
  const pending = Promise.withResolvers<{ url: string; filename: string }>();
  const download = vi.fn(async (_signal: AbortSignal) => ({ url: source, filename: "brief.pdf" }));
  const panel = await mountAttachment({
    src: undefined,
    sourceIdentity: "session-file:original",
    file: { path: "brief.pdf", download },
  });
  await waitForSolid(() => expect(panel.querySelector("iframe")).not.toBeNull());
  const original = panel.querySelector("iframe")!;
  download.mockReturnValueOnce(pending.promise);
  panel.content = {
    ...panel.content,
    sourceIdentity: "session-file:replacement",
    file: { path: "replacement.pdf", download },
  };
  await waitForSolid(() => {
    expect(download).toHaveBeenCalledTimes(2);
    expect(original.isConnected).toBe(false);
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      `blob:${location.origin}/pdf-preview`,
    );
  });
  panel.remove();
  await waitForSolid(() => expect(download.mock.calls[1]?.[0].aborted).toBe(true));
  pending.resolve({ url: source, filename: "replacement.pdf" });
  await waitForSolid(() => expect(panel.querySelector("iframe")).toBeNull());
  expect(fetcher).toHaveBeenCalledOnce();
  expect(urls.createObjectURL).toHaveBeenCalledOnce();
});

it.each(["renewed", "changed", "failed", "identity", "oversized"] as const)(
  "revalidates a same-origin PDF ticket reactively: %s",
  async (change) => {
    const fetchMock = vi.fn<typeof fetch>();
    const renewal = Promise.withResolvers<Response>();
    fetchMock
      .mockResolvedValueOnce(new Response("%PDF-1.7 original"))
      .mockReturnValueOnce(renewal.promise);
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountAttachment({ sourceIdentity: "attachment:brief" });
    const query = (selector: string) => panel.querySelector(selector);
    const frameSource = () => query("iframe")?.getAttribute("src");
    const inline = (src: string) => `${src}&disposition=inline`;
    const renewedSource = "/__openclaw__/assistant-media?mediaTicket=renewed";
    await waitForSolid(() => expect(frameSource()).toBe(inline(source)));
    const frame = query("iframe")!;

    panel.content = {
      ...panel.content,
      src: renewedSource,
      sourceIdentity: change === "identity" ? "attachment:other" : "attachment:brief",
      sizeBytes: change === "oversized" ? PDF_PREVIEW_MAX_BYTES + 1 : undefined,
    };
    await panel.updateComplete;
    if (change === "oversized") {
      // Oversized media retires without a network read and offers the fallback download.
      await waitForSolid(() => {
        expect(query("[role=alert]")).not.toBeNull();
        expect(query("iframe")).toBeNull();
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(panel.querySelector("a[download]")?.getAttribute("href")).toBe(renewedSource);
      return;
    }
    // A renewed ticket re-validates the fresh src instead of pinning the expiring URL.
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    if (change === "identity") {
      // A different attachment re-mounts the reader with the fresh ticket.
      renewal.resolve(new Response("%PDF-1.7 renewed"));
      await waitForSolid(() => {
        expect(frame.isConnected).toBe(false);
        expect(query("iframe")).not.toBe(frame);
        expect(frameSource()).toBe(inline(renewedSource));
      });
      return;
    }

    if (change === "failed") {
      // A failed renewal cancels transport, retires the stale reader, and offers the fallback.
      const oversized = new Response("oversized".repeat(PDF_PREVIEW_MAX_BYTES), {
        headers: { "Content-Length": String(PDF_PREVIEW_MAX_BYTES + 1) },
      });
      const cancel = vi.spyOn(oversized.body!, "cancel");
      renewal.resolve(oversized);
      await waitForSolid(() => {
        expect(cancel).toHaveBeenCalledOnce();
        expect(query("iframe")).toBeNull();
        expect(query("[role=alert]")).not.toBeNull();
        expect(panel.querySelector("a[download]")?.getAttribute("href")).toContain("renewed");
      });
      // A later valid ticket recovers the inline reader from the prior failure.
      fetchMock.mockResolvedValueOnce(new Response("%PDF-1.7 recovered"));
      panel.content = {
        ...panel.content,
        src: "/__openclaw__/assistant-media?mediaTicket=recovered",
      };
      await panel.updateComplete;
      await waitForSolid(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(frameSource()).toBe(inline("/__openclaw__/assistant-media?mediaTicket=recovered"));
        expect(query("[role=alert]")).toBeNull();
      });
      return;
    }

    if (change === "changed") {
      // Different bytes must reach the reader, so the frame moves to the renewed URL
      // without remounting the component.
      renewal.resolve(new Response("%PDF-1.7 renewed content"));
      await waitForSolid(() => {
        expect(query("iframe")).toBe(frame);
        expect(frameSource()).toBe(inline(renewedSource));
      });
      return;
    }

    // Identical bytes keep the reader's page and zoom: the frame keeps the URL it
    // already loaded and the renewed ticket only re-validates in the background.
    renewal.resolve(new Response("%PDF-1.7 original"));
    await panel.updateComplete;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(query("iframe")).toBe(frame);
    expect(frameSource()).toBe(inline(source));
  },
);

it.each(["", "application/octet-stream"] as const)(
  "keeps the bounded Blob reader for a PDF the Gateway cannot label inline: %s",
  async (mimeType) => {
    // Filename-only PDFs are still previewed, but the Gateway would answer them as a
    // download, so the frame must not point at the ticket URL.
    const urls = stubObjectUrls();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7\n"));
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountAttachment({ mimeType });
    await waitForSolid(() => expect(panel.querySelector("iframe")).not.toBeNull());
    const frameSrc = panel.querySelector("iframe")!.getAttribute("src")!;
    expect(frameSrc).toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(source);
    expect(urls.createObjectURL).toHaveBeenCalledOnce();
  },
);

it("previews a local Blob without bypassing the file download owner", async () => {
  const urls = stubObjectUrls();
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const download = vi.fn(async () => ({
    blob: new Blob(["%PDF-1.7 local"]),
    filename: "local.pdf",
  }));
  const panel = await mountAttachment({
    src: undefined,
    sourceIdentity: "file:local",
    file: { path: "local.pdf", download },
  });
  await waitForSolid(() => expect(panel.querySelector("iframe")).not.toBeNull());
  expect(download).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
  expect(urls.createObjectURL).toHaveBeenCalledOnce();
});

it("retains Download when worker construction is refused", async () => {
  const urls = stubObjectUrls();
  vi.stubGlobal("Worker", function RefusedWorker() {
    throw new DOMException("Blocked", "SecurityError");
  });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7")));
  const download = vi.fn(async () => ({ url: source, filename: "brief.pdf" }));
  const panel = await mountAttachment({
    src: undefined,
    sourceIdentity: "session-file:brief",
    file: { path: "brief.pdf", download },
  });
  await waitForSolid(() => expect(panel.querySelector("[role=alert]")).not.toBeNull());
  expect(panel.querySelector("iframe")).toBeNull();
  expect(panel.querySelector("[role=alert] button")).not.toBeNull();
  expect(urls.createObjectURL).not.toHaveBeenCalled();
});
