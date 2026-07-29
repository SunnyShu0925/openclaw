/**
 * Test: AbortSignal is emitted on hook timeout.
 *
 * When a hook handler times out via withHookTimeout, the runner must abort
 * the handler's AbortSignal BEFORE releasing the lane so cooperative handlers
 * can observe signal.aborted and terminate owned work (child processes, etc.).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./types.js";

describe("hook handler abort signal on timeout", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("sets signal.aborted on runModifyingHook timeout (before_agent_run)", async () => {
    vi.useFakeTimers();
    try {
      const capturedSignals: Array<AbortSignal | undefined> = [];
      // A handler that never settles — will hit the modifying-hook default timeout
      const handler = vi.fn(
        (_event: unknown, ctx: PluginHookAgentContext) =>
          new Promise<void>(() => {
            capturedSignals.push(ctx.abortSignal);
          }),
      );
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "before_agent_run",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = { error: vi.fn(), warn: vi.fn() };
      const runner = createHookRunner(registry, {
        logger,
        catchErrors: true,
        failurePolicyByHook: { before_agent_run: "fail-open" },
      });

      const run = runner.runBeforeAgentRun({ prompt: "test", messages: [] }, TEST_PLUGIN_AGENT_CTX);

      // Advance past the default before_agent_run timeout (15s)
      await vi.advanceTimersByTimeAsync(15_001);

      await expect(run).resolves.toBeUndefined();
      expect(capturedSignals).toHaveLength(1);
      expect(capturedSignals[0]).toBeDefined();
      expect(capturedSignals[0]!.aborted).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "before_agent_run handler from plugin-a failed: timed out after 15000ms",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets signal.aborted on runVoidHook timeout (before_compaction)", async () => {
    vi.useFakeTimers();
    try {
      const capturedSignals: Array<AbortSignal | undefined> = [];
      const handler = vi.fn(
        (_event: unknown, ctx: PluginHookAgentContext) =>
          new Promise<void>(() => {
            capturedSignals.push(ctx.abortSignal);
          }),
      );
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "before_compaction",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = { error: vi.fn(), warn: vi.fn() };
      const runner = createHookRunner(registry, { logger });

      const run = runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX);

      // Advance past the default compaction hook timeout (30s)
      await vi.advanceTimersByTimeAsync(30_001);

      await expect(run).resolves.toBeUndefined();
      expect(capturedSignals).toHaveLength(1);
      expect(capturedSignals[0]).toBeDefined();
      expect(capturedSignals[0]!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not set signal.aborted when handler completes before timeout", async () => {
    vi.useFakeTimers();
    try {
      const capturedSignals: Array<AbortSignal | undefined> = [];
      const handler = vi.fn(async (_event: unknown, ctx: PluginHookAgentContext) => {
        capturedSignals.push(ctx.abortSignal);
      });
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "before_agent_run",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = { error: vi.fn(), warn: vi.fn() };
      const runner = createHookRunner(registry, {
        logger,
        catchErrors: true,
        failurePolicyByHook: { before_agent_run: "fail-open" },
      });

      const run = runner.runBeforeAgentRun({ prompt: "test", messages: [] }, TEST_PLUGIN_AGENT_CTX);

      // Resolve immediately without advancing timers
      await expect(run).resolves.toBeUndefined();
      expect(capturedSignals).toHaveLength(1);
      expect(capturedSignals[0]).toBeDefined();
      expect(capturedSignals[0]!.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects abortSignal into the handler context (test compatibility)", async () => {
    // Verifies the context spread works: TEST_PLUGIN_AGENT_CTX fields are
    // preserved and abortSignal is appended.
    const handler = vi.fn(async (_event: unknown, ctx: PluginHookAgentContext) => {
      expect(ctx.runId).toBe("test-run-id");
      expect(ctx.agentId).toBe("test-agent");
      expect(ctx.sessionKey).toBe("test-session");
      expect(ctx.abortSignal).toBeDefined();
      expect(ctx.abortSignal!.aborted).toBe(false);
    });
    addTestHook({
      registry,
      pluginId: "plugin-a",
      hookName: "before_agent_run",
      handler: handler as PluginHookRegistration["handler"],
    });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const runner = createHookRunner(registry, {
      logger,
      catchErrors: true,
      failurePolicyByHook: { before_agent_run: "fail-open" },
    });

    await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, TEST_PLUGIN_AGENT_CTX);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("preserves existing handler behavior when abortSignal is not used", async () => {
    // A handler that neither reads nor returns abortSignal must still work.
    const handler = vi.fn(async () => undefined);
    addTestHook({
      registry,
      pluginId: "plugin-a",
      hookName: "before_agent_run",
      handler: handler as unknown as PluginHookRegistration["handler"],
    });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const runner = createHookRunner(registry, {
      logger,
      catchErrors: true,
      failurePolicyByHook: { before_agent_run: "fail-open" },
    });

    const result = await runner.runBeforeAgentRun(
      { prompt: "test", messages: [] },
      TEST_PLUGIN_AGENT_CTX,
    );

    // Handler returned undefined (= pass), so no decision is produced
    expect(result).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
