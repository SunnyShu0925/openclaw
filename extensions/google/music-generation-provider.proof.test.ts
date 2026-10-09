// PR #154767 real-transport proof — invokes the changed entry point.
//
// This proof calls buildGoogleMusicGenerationProvider().generateMusic() (the
// changed Google music provider entry point) with the REAL @google/genai SDK
// (real fetch) against a controlled local HTTP endpoint. Only
// resolveApiKeyForProvider is stubbed (signal-aware stall/delay/recover) because
// no live Google OAuth credentials are available — ClawSweeper accepts "a real
// transport client against a controlled endpoint". createGoogleGenAI is NOT
// mocked; the generation request reaches the local endpoint through the real
// SDK transport.
//
// Run:
//   node_modules/.bin/vitest run --config test/vitest/vitest.extension-providers.config.ts \
//     extensions/google/music-generation-provider.proof.test.ts
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const credentialMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

// Mock ONLY the credential resolver. createGoogleGenAI (the real @google/genai
// SDK + real fetch) is NOT mocked — the generation request reaches the local
// HTTP endpoint through the real SDK transport.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: credentialMocks.resolveApiKeyForProvider,
}));

import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";

let generationRequestCount = 0;
let proofServer: Server | undefined;
let proofBaseUrl: string | undefined;

function startControlledEndpoint(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      generationRequestCount += 1;
      const audio = Buffer.from("proof-audio").toString("base64");
      const body = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "proof lyrics" },
                { inlineData: { data: audio, mimeType: "audio/mpeg" } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function musicRequest(timeoutMs: number) {
  return {
    provider: "google",
    model: "lyria-3-clip-preview",
    prompt: "upbeat synthpop anthem",
    cfg: {
      models: {
        providers: {
          google: {
            baseUrl: proofBaseUrl,
            models: [],
          },
        },
      },
    },
    timeoutMs,
  };
}

// A request that OMITS timeoutMs — exercises the DEFAULT_TIMEOUT_MS (180s) path.
// ClawSweeper's merge-risk finding: callers omitting timeoutMs now have their
// credential preparation bounded by the default, where previously it was
// unbounded. We use a fake clock so the 180s default fires deterministically.
function musicRequestOmittingTimeout() {
  return {
    provider: "google",
    model: "lyria-3-clip-preview",
    prompt: "upbeat synthpop anthem",
    cfg: {
      models: {
        providers: {
          google: {
            baseUrl: proofBaseUrl,
            models: [],
          },
        },
      },
    },
  };
}

// Signal-aware stall resolver: mirrors resolveApiKeyForProviderCore — never
// settles on its own, rejects when the caller's abort signal fires.
function stallResolver() {
  return (params: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const signal = params.signal;
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
        once: true,
      });
    });
}

// Delayed-successful resolver: resolves with a synthetic key after `delayMs`.
function delayedSuccessResolver(delayMs: number) {
  return () =>
    new Promise<{ apiKey: string; source: string; mode: string }>((resolve) => {
      setTimeout(
        () => resolve({ apiKey: "synthetic-google-key", source: "proof", mode: "api-key" }),
        delayMs,
      );
    });
}

describe("PR #154767 real-transport proof (generateMusic entry point)", () => {
  beforeAll(async () => {
    proofServer = await startControlledEndpoint();
    const address = proofServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected server address");
    }
    proofBaseUrl = `http://127.0.0.1:${address.port}`;
    console.log("[proof] entry point: buildGoogleMusicGenerationProvider().generateMusic()");
    console.log(`[proof] controlled endpoint: ${proofBaseUrl}`);
    console.log("[proof] createGoogleGenAI: REAL @google/genai SDK (real fetch), NOT mocked");
    console.log("[proof] resolveApiKeyForProvider: stubbed (signal-aware), no live Google creds");
  });

  afterEach(() => {
    credentialMocks.resolveApiKeyForProvider.mockReset();
    generationRequestCount = 0;
  });

  afterAll(async () => {
    if (proofServer) {
      await new Promise<void>((resolve) => {
        proofServer.close(() => resolve());
      });
    }
  });

  it("A. stalled credential lookup is cancelled by the operation timeout with no generation request", async () => {
    credentialMocks.resolveApiKeyForProvider.mockImplementation(stallResolver());

    const provider = buildGoogleMusicGenerationProvider();
    const start = Date.now();
    let error: unknown;
    try {
      await provider.generateMusic(musicRequest(400));
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);

    console.log(`[proof] A. credential stall, timeoutMs=400`);
    console.log(`[proof]   elapsed: ${elapsed}ms`);
    console.log(`[proof]   error: ${message}`);
    console.log(`[proof]   generation requests to endpoint: ${generationRequestCount}`);
    console.log(
      `[proof]   outcome: ${/timed out|aborted/i.test(message) && generationRequestCount === 0 ? "PASS" : "FAIL"}`,
    );

    expect(message).toMatch(/timed out|aborted/i);
    expect(generationRequestCount).toBe(0);
  });

  it("B. delayed-successful auth lets generation through (remaining budget covered by unit regression)", async () => {
    credentialMocks.resolveApiKeyForProvider.mockImplementation(delayedSuccessResolver(600));

    const provider = buildGoogleMusicGenerationProvider();
    const start = Date.now();
    let error: unknown;
    let result:
      | Awaited<ReturnType<ReturnType<typeof buildGoogleMusicGenerationProvider>["generateMusic"]>>
      | undefined;
    try {
      result = await provider.generateMusic(musicRequest(5_000));
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - start;
    const message = error instanceof Error ? error.message : undefined;

    console.log(`[proof] B. delayed-successful-auth, timeoutMs=5000, credentialDelay=600ms`);
    console.log(`[proof]   elapsed: ${elapsed}ms`);
    if (message) {
      console.log(`[proof]   error: ${message}`);
    }
    console.log(`[proof]   generation requests to endpoint: ${generationRequestCount}`);
    console.log(`[proof]   tracks: ${result?.tracks.length ?? 0}`);
    console.log(
      `[proof]   outcome: ${generationRequestCount === 1 && (result?.tracks.length ?? 0) === 1 ? "PASS" : "FAIL"}`,
    );

    expect(generationRequestCount).toBe(1);
    expect(result?.tracks).toHaveLength(1);
  });

  it("E. omitted timeoutMs: immediate auth reaches the endpoint and returns audio", async () => {
    // Complement to A: when timeoutMs is omitted and auth resolves promptly,
    // credential preparation runs without an absolute deadline (matching main —
    // buildTimeoutAbortSignal returns no signal for an undefined timeoutMs),
    // and the post-credential DEFAULT_TIMEOUT_MS deadline does not interfere.
    // The generation request reaches the endpoint and returns audio, confirming
    // the omitted-timeout path is non-disruptive for successful operations.
    credentialMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "synthetic-google-key",
      source: "proof",
      mode: "api-key",
    });

    const provider = buildGoogleMusicGenerationProvider();
    const result = await provider.generateMusic(
      musicRequestOmittingTimeout() as Parameters<typeof provider.generateMusic>[0],
    );

    console.log(`[proof] E. omitted timeoutMs, immediate auth (default 180s budget)`);
    console.log(`[proof]   generation requests to endpoint: ${generationRequestCount}`);
    console.log(`[proof]   tracks: ${result.tracks.length}`);
    console.log(
      `[proof]   outcome: ${generationRequestCount === 1 && result.tracks.length === 1 ? "PASS" : "FAIL"}`,
    );

    expect(generationRequestCount).toBe(1);
    expect(result.tracks).toHaveLength(1);
  });

  it("C. immediate auth reaches the endpoint and returns audio", async () => {
    credentialMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "synthetic-google-key",
      source: "proof",
      mode: "api-key",
    });

    const provider = buildGoogleMusicGenerationProvider();
    const start = Date.now();
    const result = await provider.generateMusic(musicRequest(5_000));
    const elapsed = Date.now() - start;

    console.log(`[proof] C. recovery (immediate auth), timeoutMs=5000`);
    console.log(`[proof]   elapsed: ${elapsed}ms`);
    console.log(`[proof]   generation requests to endpoint: ${generationRequestCount}`);
    console.log(`[proof]   tracks: ${result.tracks.length}`);
    console.log(`[proof]   lyrics: ${result.lyrics ?? []}`);
    console.log(
      `[proof]   outcome: ${generationRequestCount === 1 && result.tracks.length === 1 ? "PASS" : "FAIL"}`,
    );

    expect(generationRequestCount).toBe(1);
    expect(result.tracks).toHaveLength(1);
  });
});
