import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  applyAssistantMediaInlinePreviewHeaders,
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "./control-ui-csp.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";

describe("buildControlUiCspHeader", () => {
  it("restricts execution and resource loading to the baseline security policy", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("frame-src 'self' blob: http: https:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("media-src 'self' data: blob:");
    expect(csp).not.toContain("media-src 'self' data: blob: https:");
    expect(csp).not.toContain("wasm-unsafe-eval");
    const imgSrc = csp.split("; ").find((directive) => directive.startsWith("img-src "));
    expect(imgSrc?.split(" ")).toEqual(["img-src", "'self'", "data:", "blob:", "https:"]);
    const connectSrc = csp.split("; ").find((directive) => directive.startsWith("connect-src "));
    expect(connectSrc?.split(" ")).toEqual([
      "connect-src",
      "'self'",
      "ws:",
      "wss:",
      "data:",
      "blob:",
      "https://api.openai.com",
      "https://tweakcn.com",
    ]);
  });

  it("allows portal probes only across ports on the current document host", () => {
    const csp = buildControlUiCspHeader({ portalHost: "gateway.example.test:18789" });
    const connectSrc = csp.split("; ").find((directive) => directive.startsWith("connect-src "));
    expect(connectSrc?.split(" ")).toContain("http://gateway.example.test:*");
    expect(connectSrc?.split(" ")).toContain("https://gateway.example.test:*");
    expect(connectSrc?.split(" ")).not.toContain("https:");

    const invalid = buildControlUiCspHeader({
      portalHost: "gateway.example.test/path;connect-src https://example.test",
    });
    expect(invalid).not.toContain("https://example.test");
  });

  it("includes multiple inline script hashes", () => {
    const csp = buildControlUiCspHeader({
      inlineScriptHashes: ["sha256-aaa", "sha256-bbb"],
    });
    expect(csp).toContain("script-src 'self' 'sha256-aaa' 'sha256-bbb'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("keeps inline script hashes alongside the wasm relaxation", () => {
    const csp = buildControlUiCspHeader({
      inlineScriptHashes: ["sha256-abc123"],
      allowWasm: true,
    });
    expect(csp).toContain("'sha256-abc123'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'(?!-)/);
  });
});

describe("applyAssistantMediaInlinePreviewHeaders", () => {
  function makeResponse() {
    const headers: Record<string, string> = {};
    const removed: string[] = [];
    const res = {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      removeHeader(name: string) {
        removed.push(name);
        delete headers[name];
      },
    } as unknown as ServerResponse;
    return { res, headers, removed };
  }

  it("frames only for this same-origin document", () => {
    const { res, headers, removed } = makeResponse();
    applyAssistantMediaInlinePreviewHeaders(res);
    expect(removed).toEqual(["X-Frame-Options"]);
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
  });

  it("admits the Control UI origin alongside the configured outer ancestors", () => {
    const { res, headers } = makeResponse();
    // Nested reader: the Control UI document (publicOrigin) is the immediate
    // parent, and its own configured ancestors sit above it.
    applyAssistantMediaInlinePreviewHeaders(
      res,
      createRemoteControlUiIngressTestContext({
        publicOrigin: "https://ui.example.test",
        frameAncestors: ["https://host.example.test"],
      }),
    );
    const frameAncestors = headers["Content-Security-Policy"]
      ?.split("; ")
      .find((directive) => directive.startsWith("frame-ancestors "));
    expect(frameAncestors?.split(" ")).toEqual([
      "frame-ancestors",
      "https://ui.example.test",
      "https://host.example.test",
    ]);
  });

  it("rejects a stale ingress snapshot before relaxing framing", () => {
    const { res, headers, removed } = makeResponse();
    expect(() =>
      applyAssistantMediaInlinePreviewHeaders(
        res,
        createRemoteControlUiIngressTestContext({
          assertCurrent() {
            throw new Error("stale ingress");
          },
        }),
      ),
    ).toThrow("stale ingress");
    expect(removed).toEqual([]);
    expect(headers["Content-Security-Policy"]).toBeUndefined();
  });
});

describe("computeInlineScriptHashes", () => {
  it("does not treat data-src as an external script attribute", () => {
    const content = "console.log('inline')";
    const expected = createHash("sha256").update(content, "utf8").digest("base64");
    const hashes = computeInlineScriptHashes(
      `<html><script data-src="/app.js">${content}</script></html>`,
    );
    expect(hashes).toEqual([`sha256-${expected}`]);
  });

  it("hashes only inline scripts when mixed with external", () => {
    const inlineContent = "console.log('init')";
    const expected = createHash("sha256").update(inlineContent, "utf8").digest("base64");
    const html = [
      "<html><head>",
      `<script>${inlineContent}</script>`,
      '<script type="module" src="/app.js"></script>',
      "</head></html>",
    ].join("");
    const hashes = computeInlineScriptHashes(html);
    expect(hashes).toEqual([`sha256-${expected}`]);
  });

  it("skips empty inline scripts", () => {
    expect(computeInlineScriptHashes("<script></script>")).toStrictEqual([]);
  });
});
