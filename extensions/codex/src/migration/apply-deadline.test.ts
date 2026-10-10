import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
// Regression coverage for the marketplace discovery deadline clock domain.
// The discovery polling loop in requestTargetCodexAppServerJson must seed its
// deadline with performance.now() (monotonic) so NTP adjustments or sleep
// resumes cannot stretch or shrink the budget while request timers (also
// monotonic) are in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedTimeoutMs: number[] = [];

const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    // Advance the monotonic clock so the polling loop makes progress.
    await vi.advanceTimersByTimeAsync(ms);
  }),
);

const requestMock = vi.hoisted(() =>
  vi.fn(async (params: { method: string; timeoutMs?: number }) => {
    if (params.timeoutMs !== undefined) {
      capturedTimeoutMs.push(params.timeoutMs);
    }
    // Rewind the wall clock after the first RPC so subsequent remaining-budget
    // computations run against a regressed Date.now().
    if (capturedTimeoutMs.length === 1) {
      vi.setSystemTime(-120_000);
    }
    // On the second RPC, return a response with the OpenAI-curated marketplace
    // so the polling loop exits without waiting for the full 30s deadline.
    if (capturedTimeoutMs.length >= 2) {
      return {
        marketplaces: [{ name: "openai-curated", path: "/curated" }],
        marketplaceLoadErrors: [],
      };
    }
    return {
      marketplaces: [{ name: "custom-marketplace", path: "/custom" }],
      marketplaceLoadErrors: [],
    };
  }),
);

const activationMock = vi.hoisted(() =>
  vi.fn(
    async (params: { request: (method: string, requestParams?: unknown) => Promise<unknown> }) => {
      await params.request("plugin/list", undefined);
      return {
        identity: { pluginName: "test-plugin", marketplaceName: "openai-curated" },
        ok: true,
        reason: "already_active",
        installAttempted: false,
        diagnostics: [],
      };
    },
  ),
);

vi.mock("../app-server/request.js", () => ({
  requestCodexAppServerJson: requestMock,
  withCodexAppServerJsonClient: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleep: sleepMock,
}));

vi.mock("../app-server/plugin-activation.js", () => ({
  ensureCodexPluginActivation: activationMock,
}));

vi.mock("../app-server/plugin-app-cache-key.js", () => ({
  buildCodexPluginAppCacheKey: vi.fn(async () => "test-cache-key"),
}));

vi.mock("../app-server/auth-bridge.js", () => ({
  resolveCodexAppServerAuthAccountCacheKey: vi.fn(async () => undefined),
}));

vi.mock("../app-server/auth-cache-key.js", () => ({
  resolveCodexAppServerFallbackApiKeyCacheKey: vi.fn(() => undefined),
}));

vi.mock("../app-server/auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(() => undefined),
}));

import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { applyCodexMigrationPlan } from "./apply.js";

describe("Codex migration marketplace discovery deadline", () => {
  beforeEach(() => {
    capturedTimeoutMs.length = 0;
    requestMock.mockClear();
    sleepMock.mockClear();
    activationMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the discovery deadline bounded when the wall clock rewinds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const tmpDir = resolvePreferredOpenClawTmpDir();

    const pluginItem = {
      id: "plugin:test-plugin",
      kind: "plugin",
      action: "install",
      status: "planned",
      source: "/source/.codex",
      destination: "/dest/agent",
      details: {
        configKey: "test-plugin",
        marketplaceName: "openai-curated",
        pluginName: "test-plugin",
      },
    } as unknown as MigrationItem;

    const plan = {
      source: "/source/.codex",
      items: [pluginItem],
      metadata: { codexHome: "/source/.codex" },
    } as unknown as MigrationPlan;

    const ctx = {
      config: {
        agents: { defaults: { workspace: "/dest/workspace" } },
        plugins: { entries: { codex: { enabled: true, config: {} } } },
      },
      source: "/source/.codex",
      stateDir: tmpDir,
      reportDir: undefined,
    } as unknown as MigrationProviderContext;

    await applyCodexMigrationPlan({ ctx, plan });

    // The polling loop must have issued at least two RPCs: the first seeds the
    // deadline, and the second runs after the wall clock rewinds.
    expect(capturedTimeoutMs.length).toBeGreaterThanOrEqual(2);

    // Every RPC must receive a timeout bounded by the 60s budget, even after
    // the wall clock rewinds. A wall-clock budget would hand the second RPC a
    // timeoutMs well above 60_000.
    for (const captured of capturedTimeoutMs) {
      expect(captured).toBeLessThanOrEqual(60_000);
    }
  });
});
