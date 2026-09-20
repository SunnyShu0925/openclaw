import { describe, expect, it, vi } from "vitest";

const resolveSelectedAgentHarnessRuntimeMock = vi.fn((selection: any) => {
  // Simulate the issue: an agent without a configured agentRuntime policy
  // resolves "auto" when its agentId is known, but resolves to a different
  // runtime ("openclaw") when agentId is absent (compatibility agent fallback).
  return selection.agentId ? "auto" : "openclaw";
});

vi.mock("./harness/runtime-plugin-load-plan.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    resolveSelectedAgentHarnessRuntime: resolveSelectedAgentHarnessRuntimeMock,
  };
});

const { normalizePreparedModelRuntimeInput, ownerKey } =
  await import("./prepared-model-runtime.owner.js");

describe("normalizePreparedModelRuntimeInput agent scope (#153313)", () => {
  it("passes input.agentId as fallback so normalize is idempotent across calls", () => {
    resolveSelectedAgentHarnessRuntimeMock.mockClear();

    const config = { agents: { defaults: { model: "xai/grok-4.6" } } } as any;
    const input = {
      config,
      agentId: "cipher-pilot",
      agentDir: "/tmp/cipher-pilot",
      runtimePluginSelections: [{ provider: "xai", modelId: "grok-4.6", runtime: "auto" }],
    } as any;

    const first = normalizePreparedModelRuntimeInput(input);
    const firstRuntime = first.runtimePluginSelections?.[0]?.runtime;

    // Second normalization: entry no longer carries agentId (discarded by design),
    // but normalize should still use input.agentId as fallback.
    const second = normalizePreparedModelRuntimeInput(first);
    const secondRuntime = second.runtimePluginSelections?.[0]?.runtime;

    // Both calls should have received agentId="cipher-pilot" (from input.agentId fallback)
    expect(resolveSelectedAgentHarnessRuntimeMock).toHaveBeenCalledTimes(2);
    expect(resolveSelectedAgentHarnessRuntimeMock.mock.calls[0][0].agentId).toBe("cipher-pilot");
    expect(resolveSelectedAgentHarnessRuntimeMock.mock.calls[1][0].agentId).toBe("cipher-pilot");

    // Same runtime → same key → no livelock
    expect(firstRuntime).toBe(secondRuntime);
    expect(ownerKey(first)).toBe(ownerKey(second));
  });
});
