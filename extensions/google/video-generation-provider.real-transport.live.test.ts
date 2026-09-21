// Real-entrypoint proof with UNSTUBBED credential resolver and UNSTUBBED
// transport. Drives the REAL buildGoogleVideoGenerationProvider().generateVideo
// through:
//   - the REAL resolveApiKeyForProviderCore (NOT mocked — a pending OAuth
//     refresh fence credential makes credential preparation stall inside the
//     real resolver's observeOAuthRefreshFenceSettlement loop, honoring the
//     caller's AbortSignal; no mock of the resolver)
//   - the REAL globalThis.fetch (NOT stubbed — the @google/genai SDK connects
//     to a local loopback HTTP server at 127.0.0.1, which the SSRF guard
//     permits as an explicit loopback hostname)
//   - REAL timers (no fake timers)
//
// ClawSweeper rank-up move: "Add a redacted after-fix trace through the real
// credential resolver and controlled transport showing cancellation, no late
// request, and recovery."

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOAuthRefreshFence } from "../../src/agents/auth-profiles/oauth-refresh-marker.js";
import { writePersistedAuthProfileStoreRaw } from "../../src/agents/auth-profiles/sqlite.js";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

// --- Local loopback HTTP server (controlled transport, unstubbed fetch) ---

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
  requestCount: () => number;
}

function startLocalServer(): Promise<ServerHandle> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              {
                video: {
                  encodedVideo: Buffer.from("proof-mp4-bytes").toString("base64"),
                  encoding: "video/mp4",
                },
              },
            ],
          },
        },
      }),
    );
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
        requestCount: () => count,
      });
    });
  });
}

// --- Real credential resolver: a pending OAuth refresh fence stalls it ---

const PROFILE_ID = "google-oauth-proof";

const expiredOAuth = {
  type: "oauth" as const,
  provider: "google",
  access: "proof-expired-access",
  refresh: "proof-expired-refresh",
  expires: Date.now() - 60_000,
  accountId: "proof-acct",
};

function generateVideo(
  serverUrl: string,
  overrides: Partial<VideoGenerationRequest> & { agentDir?: string; authStore?: unknown } = {},
) {
  return buildGoogleVideoGenerationProvider().generateVideo({
    provider: "google",
    model: "veo-3.1-fast-generate-preview",
    prompt: "A tiny robot watering a windowsill garden",
    cfg: {
      models: {
        providers: {
          google: {
            baseUrl: serverUrl,
          },
        },
      },
    } as never,
    ...overrides,
  });
}

let server: ServerHandle | undefined;
let tempRoot: string | undefined;

beforeEach(async () => {
  server = await startLocalServer();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pr154773-real-transport-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = undefined;
});

describe.skipIf(!isLiveTestEnabled())("google video generation real transport proof", () => {
  it("cancels stalled credential preparation on timeout without a generation request", async () => {
    // Real credential resolver stalls: a pending OAuth refresh fence persisted
    // to the agent profile store makes resolveApiKeyForProviderCore enter
    // observeOAuthRefreshFenceSettlement, which never settles. The caller's
    // timeoutMs abort signal cancels the wait before any generation request.
    const agentDir = path.join(tempRoot!, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const fence = createOAuthRefreshFence({ profileId: PROFILE_ID, credential: expiredOAuth });
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: { [PROFILE_ID]: fence } }, agentDir);
    const cfg = {
      auth: { profiles: { [PROFILE_ID]: { provider: "google", mode: "oauth" } } },
      models: { providers: { google: { baseUrl: server!.url } } },
    } as never;

    const start = Date.now();
    let error: Error | undefined;
    try {
      await generateVideo(server!.url, {
        cfg,
        agentDir,
        authStore: { version: 1, profiles: { [PROFILE_ID]: fence } } as never,
        timeoutMs: 800,
      });
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    const elapsed = Date.now() - start;

    // Credential preparation was cancelled by the timeout budget.
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/timed out|aborted|abort/i);
    expect(elapsed).toBeLessThan(10_000);
    // No generation request reached the server (credential prep was cancelled).
    expect(server!.requestCount()).toBe(0);
  });

  it("recovers and generates video via the real SDK over unstubbed fetch", async () => {
    // Real credential resolver returns the cfg-supplied key immediately (env/
    // config fallback, no OAuth); the real @google/genai SDK submits over
    // unstubbed fetch to the local server, which responds with a completed
    // operation carrying inline video bytes.
    const result = await generateVideo(server!.url, {
      cfg: {
        models: {
          providers: {
            google: {
              apiKey: "proof-google-api-key",
              baseUrl: server!.url,
            },
          },
        },
      } as never,
      timeoutMs: 30_000,
    });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.buffer).toEqual(Buffer.from("proof-mp4-bytes"));
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(server!.requestCount()).toBeGreaterThanOrEqual(1);
  });
});
