// Real-behavior proof: a projected delegated compaction (only agentId + sessionId
// survive the host-param compatibility projection) must resolve the configured
// custom session.store and find the real stored session key in it, instead of
// falling back to the default per-agent store and substituting the sessionId
// UUID for the session key.
//
// This proof does NOT mock the delegate's store-resolution logic, the resolver,
// or the SQLite session-accessor. It mocks only:
//   - getRuntimeConfig (to pin a non-default session.store without writing a
//     real config file)
//   - compactEmbeddedAgentSessionDirect (to capture what the delegate forwards
//     without running a full LLM compaction)
// Everything upstream of that boundary — delegate.ts store-resolution,
// resolveAgentRunSessionTarget, listSessionEntries, real SQLite upsert/read —
// runs as shipped. Mirrors the compaction.failure-proof.test.ts pattern.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";

const { compactEmbeddedAgentSessionDirectMock, runtimeConfigMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionDirectMock: vi.fn(),
  runtimeConfigMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionDirect: compactEmbeddedAgentSessionDirectMock,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    getRuntimeConfig: runtimeConfigMock,
  };
});

const { resolveStorePath } = await import("../config/sessions/paths.js");
const { upsertSessionEntry, listSessionEntries } =
  await import("../config/sessions/session-accessor.js");
const { resolveAgentRunSessionTarget } = await import("../agents/run-session-target.js");
const { delegateCompactionToRuntime } = await import("./delegate.js");

function installCompactRuntimeCapture() {
  return compactEmbeddedAgentSessionDirectMock.mockImplementation(async (params) => {
    // Capture exactly what the delegate forwarded, then run the REAL resolver
    // against it (the same resolver compactEmbeddedAgentSessionDirect would
    // call internally) so the proof exercises the full delegate → resolver →
    // session-accessor chain with the storePath the delegate attached.
    const resolved = await resolveAgentRunSessionTarget(params);
    return {
      ok: true,
      compacted: false,
      reason: "proof capture",
      result: undefined,
      proofResolved: resolved,
    };
  });
}

describe("delegated compaction store identity real-behavior proof (#119018)", () => {
  let proofRoot: string;

  beforeAll(() => {
    proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr-119018-proof-"));
  });

  afterAll(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(proofRoot, { recursive: true, force: true });
  });

  it("a projected delegate resolves the configured custom store and the real session key", async () => {
    // Config declares a NON-DEFAULT session.store. This is what
    // getRuntimeConfig().session?.store returns inside the delegate.
    const customStore = `${proofRoot}/custom-state/{agentId}/sessions.json`;
    runtimeConfigMock.mockReturnValue({ session: { store: customStore } });
    installCompactRuntimeCapture();

    const agentId = "main";
    const sessionId = "proof-session-uuid";
    const realSessionKey = "agent:main:proof-real-key";

    const storePath = resolveStorePath(customStore, { agentId });
    const defaultStorePath = resolveStorePath(undefined, { agentId });

    // Write a REAL session entry into the CUSTOM store, mapping sessionId ->
    // realSessionKey. The entry must NOT exist in the default store.
    await upsertSessionEntry(
      { agentId, sessionKey: realSessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    const entriesInCustom = listSessionEntries({ agentId, storePath }).filter(
      ({ entry }) => entry.sessionId === sessionId,
    );
    const entriesInDefault = listSessionEntries({ agentId, storePath: defaultStorePath }).filter(
      ({ entry }) => entry.sessionId === sessionId,
    );

    // Proof step 1: the real session entry lives in the custom store, not the default.
    expect(entriesInCustom).toHaveLength(1);
    expect(entriesInDefault).toHaveLength(0);

    // Call the REAL delegate with PROJECTED params: only agentId + sessionId
    // survive the host-param projection for an undeclared engine (no
    // sessionTarget, no sessionKey, no runtimeContext).
    await delegateCompactionToRuntime({
      agentId,
      sessionId,
      tokenBudget: 4096,
    } as Parameters<typeof delegateCompactionToRuntime>[0]);

    // Proof step 2: the delegate re-attached the configured custom store path
    // (not the default) to the sessionTarget forwarded to the runtime.
    const forwarded = compactEmbeddedAgentSessionDirectMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(forwarded).toBeTruthy();
    const forwardedSessionTarget = forwarded!.sessionTarget as
      | { agentId?: string; storePath?: string; sessionKey?: string }
      | undefined;
    expect(forwardedSessionTarget).toMatchObject({
      agentId,
      storePath,
    });
    expect(forwardedSessionTarget).not.toHaveProperty("sessionKey");
    expect(forwardedSessionTarget?.storePath).not.toBe(defaultStorePath);

    // Proof step 3: the REAL resolver, given the storePath the delegate
    // attached, returns the real stored session key — not the sessionId UUID.
    const resolvedResult = (await compactEmbeddedAgentSessionDirectMock.mock.results[0]?.value) as
      | { proofResolved?: { sessionKey?: string; storePath?: string } }
      | undefined;
    const resolved = resolvedResult?.proofResolved;
    expect(resolved).toBeTruthy();
    expect(resolved!.sessionKey).toBe(realSessionKey);
    expect(resolved!.sessionKey).not.toBe(sessionId);
    expect(resolved!.storePath).toBe(storePath);
  });

  it("without the delegate fix the resolver falls back to the default store and misses the custom-store row", async () => {
    // Contrast proof: if the delegate did NOT attach the configured storePath
    // (pre-fix behavior), the resolver would search the default store, find no
    // row for the sessionId, and fall back to a sessionId-derived key.
    const customStore = `${proofRoot}/custom-state-2/{agentId}/sessions.json`;
    runtimeConfigMock.mockReturnValue({ session: { store: customStore } });

    const agentId = "main";
    const sessionId = "proof-session-uuid-2";
    const realSessionKey = "agent:main:proof-real-key-2";
    const storePath = resolveStorePath(customStore, { agentId });
    const defaultStorePath = resolveStorePath(undefined, { agentId });

    await upsertSessionEntry(
      { agentId, sessionKey: realSessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );

    // The resolver with NO storePath (pre-fix delegate did not attach one)
    // searches the default store and cannot find the real key.
    const resolvedWithoutStore = await resolveAgentRunSessionTarget({
      agentId,
      sessionId,
    });
    expect(resolvedWithoutStore.sessionKey).not.toBe(realSessionKey);
    expect(resolvedWithoutStore.storePath).not.toBe(storePath);
    // And the default store genuinely has no row for this sessionId.
    const defaultMatches = listSessionEntries({ agentId, storePath: defaultStorePath }).filter(
      ({ entry }) => entry.sessionId === sessionId,
    );
    expect(defaultMatches).toHaveLength(0);
  });
});
