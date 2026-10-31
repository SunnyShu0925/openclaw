import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { saveMediaBuffer } from "../media/store.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("PDF preview disposition", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(clearRuntimeConfigSnapshot);

  async function deliver(
    mimeType: string,
    name: string,
    extra: Record<string, string> = {},
    bytes = "%PDF-1.7\n",
  ): Promise<ServerResponse> {
    const saved = await saveMediaBuffer(Buffer.from(bytes), mimeType, "inbound", undefined, name);
    try {
      const params = new URLSearchParams({
        source: `media://inbound/${saved.id}`,
        token: "test-token",
        ...extra,
      });
      const { res } = makeMockHttpResponse();
      const handled = await handleControlUiAssistantMediaRequest(
        {
          url: `/__openclaw__/assistant-media?${params}`,
          method: "GET",
          headers: {},
          headersDistinct: {},
          socket: { remoteAddress: "127.0.0.1" },
        } as IncomingMessage,
        res,
        { auth: { mode: "token", token: "test-token", allowTailscale: false } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      return res;
    } finally {
      await fs.rm(saved.path, { force: true });
    }
  }

  it("serves an inline PDF preview the sidebar may frame", async () => {
    const res = await deliver("application/pdf", "quarterly-report.pdf", {
      disposition: "inline",
    });
    expect(res["setHeader"]).toHaveBeenCalledWith(
      "Content-Disposition",
      `inline; filename="quarterly-report.pdf"; filename*=UTF-8''quarterly-report.pdf`,
    );
    // Only this byte response drops the anti-framing baseline so the reader renders.
    expect(res["removeHeader"]).toHaveBeenCalledWith("X-Frame-Options");
    expect(res["setHeader"]).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("frame-ancestors 'self'"),
    );
  });

  it("serves a PDF as an attachment by default", async () => {
    const res = await deliver("application/pdf", "quarterly-report.pdf");
    expect(res["setHeader"]).toHaveBeenCalledWith(
      "Content-Disposition",
      `attachment; filename="quarterly-report.pdf"; filename*=UTF-8''quarterly-report.pdf`,
    );
    expect(res["setHeader"]).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(res["removeHeader"]).not.toHaveBeenCalledWith("X-Frame-Options");
    expect(res["setHeader"]).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("frame-ancestors 'none'"),
    );
  });

  it("keeps the baseline framing policy when the inline flag is not a PDF", async () => {
    // Real PNG magic: the handler sniffs the served prefix, so PDF bytes would
    // prove the PDF path instead of the non-PDF one.
    const png = "\x89PNG\r\n\x1a\n";
    const res = await deliver("image/png", "diagram.png", { disposition: "inline" }, png);
    expect(res["setHeader"]).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(res["removeHeader"]).not.toHaveBeenCalledWith("X-Frame-Options");
    expect(res["setHeader"]).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("frame-ancestors 'none'"),
    );
  });
});

describe("inbound attachment download filenames", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(clearRuntimeConfigSnapshot);

  it.each([
    { hint: undefined, expected: "café_雪.txt" },
    { hint: "../folder\\café 雪 🦞\r\n.txt", expected: "café 雪 🦞__.txt" },
    { hint: "..", expected: "café_雪.txt" },
  ])("serves inbound media with filename hint $hint", async ({ hint, expected }) => {
    const bytes = Buffer.from("café|雪|🦞\r\n139+241=380\r\n");
    const saved = await saveMediaBuffer(
      bytes,
      "text/plain",
      "inbound",
      undefined,
      "café 雪 🦞.txt",
    );
    const params = new URLSearchParams({
      source: `media://inbound/${saved.id}`,
      token: "test-token",
    });
    if (hint !== undefined) {
      params.set("filename", hint);
    }
    try {
      const { res } = makeMockHttpResponse();
      const handled = await handleControlUiAssistantMediaRequest(
        {
          url: `/__openclaw__/assistant-media?${params}`,
          method: "GET",
          headers: {},
          headersDistinct: {},
          socket: { remoteAddress: "127.0.0.1" },
        } as IncomingMessage,
        res,
        { auth: { mode: "token", token: "test-token", allowTailscale: false } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res["setHeader"]).toHaveBeenCalledWith(
        "Content-Disposition",
        buildAssistantMediaContentDisposition(expected, "text/plain"),
      );
    } finally {
      await fs.rm(saved.path, { force: true });
    }
  });
});
