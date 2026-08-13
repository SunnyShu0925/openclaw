// Live evidence for #120197 P1 fix: model-locked Codex sessions must not drop
// required-preflight turns when the thread binding is missing or stale.
//
// Real codex app-server binary + real thread + production compaction entry
// point. The producer surfaces canonical recoverable failures for the locked
// session shape; the exact-head decision layer (compact.queued.ts) is covered
// by the model-locked regressions appended to the evidence output.
import { mkdir } from "node:fs/promises";
import { maybeCompactCodexAppServerSession } from "../../extensions/codex/src/app-server/compact.js";
import { resolveCodexAppServerRuntimeOptions } from "../../extensions/codex/src/app-server/config.js";
import {
  clearCodexAppServerBindingForThread,
  registerCodexTestSessionIdentity,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "../../extensions/codex/src/app-server/session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "../../extensions/codex/src/app-server/shared-client.js";
import { isRecoverableNativeHarnessBindingFailure } from "../../src/agents/harness/compaction-recovery.js";

const root = "/tmp/codex-live-locked-preflight";
const agentDir = root + "/agent";
const sessionFile = root + "/session.jsonl";
const sessionId = "live-locked-session-1";
const sessionKey = "agent:main:live-locked-session-1";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`[live] ${condition ? "✅ PASS" : "❌ FAIL"}: ${label}`);
  console.log(`       ${detail}`);
  if (!condition) failures += 1;
}

await mkdir(agentDir, { recursive: true });
const runtime = resolveCodexAppServerRuntimeOptions({
  pluginConfig: { appServer: { homeScope: "user" } },
  env: {},
});
const client = await createIsolatedCodexAppServerClient({
  startOptions: runtime.start,
  agentDir,
  authProfileId: null,
  timeoutMs: 120_000,
});
console.log("[live] real codex app-server connected (transport:", runtime.start.transport, ")");

try {
  const listed = await client.request(
    "model/list",
    { limit: 100, cursor: null, includeHidden: false },
    { timeoutMs: 30_000 },
  );
  const modelId = listed.data?.find((m: any) => m.isDefault)?.model ?? listed.data?.[0]?.model;
  const started = await client.request(
    "thread/start",
    {
      input: [{ type: "user", text: "Reply with the single word OK." }],
      model: modelId,
      cwd: root,
      ephemeral: true,
    },
    { timeoutMs: 120_000 },
  );
  const threadId = started.thread?.id;
  console.log("[live] real thread created:", threadId);

  // Reply preflight passes modelSelectionLocked=true for persisted Codex
  // sessions; the native request shape is required_preflight.
  registerCodexTestSessionIdentity(sessionFile, sessionId, sessionKey, "main");
  console.log(
    "[live] session shape: modelSelectionLocked=true agentHarnessId=codex preflightRequired=true trigger=budget",
  );

  const baseParams = {
    sessionId,
    sessionKey,
    sessionFile,
    workspaceDir: root,
    provider: "openai",
    model: modelId,
    trigger: "budget" as const,
    preflightRequired: true,
    currentTokenCount: 456,
  };
  const nativeOptions = {
    allowNonManualNativeRequest: true,
    nativeCompactionRequest: "required_preflight",
    clientFactory: async () => client,
    nativeCompletionTimeoutMs: 60_000,
    nativeInterruptGraceMs: 1_000,
  };

  // Scenario A: missing thread binding -> canonical recoverable failure.
  await clearCodexAppServerBindingForThread(sessionId, threadId);
  const missing = await maybeCompactCodexAppServerSession(baseParams as never, {
    bindingStore: testCodexAppServerBindingStore,
    ...nativeOptions,
  });
  check(
    "missing binding returns a canonical recoverable failure",
    missing?.ok === false &&
      missing.compacted === false &&
      missing.reason === "no codex app-server thread binding" &&
      (missing as any).failure?.reason === "missing_thread_binding",
    `ok=${missing?.ok} compacted=${missing?.compacted} reason=${missing?.reason ?? "(none)"} failure=${(missing as any)?.failure?.reason ?? "(none)"}`,
  );
  check(
    "missing binding is recoverable (context-engine fallback eligible)",
    isRecoverableNativeHarnessBindingFailure(missing as never) === true,
    `isRecoverableNativeHarnessBindingFailure=${isRecoverableNativeHarnessBindingFailure(missing as never)}`,
  );

  // Scenario B: binding changes between the initial read and the guarded
  // native request -> canonical stale-binding failure (P1 race).
  await writeCodexAppServerBinding(sessionFile, {
    threadId,
    cwd: root,
    authProfileId: "live",
    clientId: "live-client",
  });
  let bindingReads = 0;
  const bindingStore = {
    ...testCodexAppServerBindingStore,
    read: (async (...args: Parameters<typeof testCodexAppServerBindingStore.read>) => {
      const result = await testCodexAppServerBindingStore.read(...args);
      if (bindingReads++ === 0) {
        seedCodexTestBinding(sessionFile, {
          threadId: "thread-2",
          cwd: root,
          authProfileId: "live",
          clientId: "live-client",
        });
      }
      return result;
    }) as typeof testCodexAppServerBindingStore.read,
  };
  const compactRequests: string[] = [];
  const clientWithProbe = Object.create(client) as {
    request(method: string, ...args: unknown[]): Promise<unknown>;
  };
  clientWithProbe.request = async (method: string, ...args: unknown[]) => {
    compactRequests.push(method);
    return (client as any).request(method, ...args);
  };
  const stale = await maybeCompactCodexAppServerSession(baseParams as never, {
    bindingStore,
    ...nativeOptions,
    clientFactory: async () => clientWithProbe as never,
  });
  check(
    "stale binding returns a canonical recoverable failure",
    stale?.ok === false &&
      stale.compacted === false &&
      stale.reason === "codex app-server binding changed before native compaction" &&
      (stale as any).failure?.reason === "stale_thread_binding",
    `ok=${stale?.ok} compacted=${stale?.compacted} reason=${stale?.reason ?? "(none)"} failure=${(stale as any)?.failure?.reason ?? "(none)"}`,
  );
  check(
    "stale binding is recoverable (context-engine fallback eligible)",
    isRecoverableNativeHarnessBindingFailure(stale as never) === true,
    `isRecoverableNativeHarnessBindingFailure=${isRecoverableNativeHarnessBindingFailure(stale as never)}`,
  );
  check(
    "no native thread/compact/start was issued on the stale binding",
    !compactRequests.includes("thread/compact/start"),
    `observed requests: ${compactRequests.join(", ") || "(none)"}`,
  );

  // Scenario C: healthy binding -> the required-preflight caller shape reaches
  // the native path (no ownership skip). An ephemeral probe thread has no
  // rollout, which itself proves the skip branch was not taken.
  await writeCodexAppServerBinding(sessionFile, {
    threadId,
    cwd: root,
    authProfileId: "live",
    clientId: "live-client",
  });
  const healthy = await maybeCompactCodexAppServerSession(baseParams as never, {
    bindingStore: testCodexAppServerBindingStore,
    ...nativeOptions,
  });
  check(
    "healthy binding bypasses the ownership skip and consults the native path",
    healthy?.reason !== "codex app-server owns automatic compaction",
    `ok=${healthy?.ok} compacted=${healthy?.compacted} reason=${healthy?.reason ?? "(none)"}`,
  );

  // Pre-fix classification: the ownership skip (ok:true compacted:false) was
  // treated as fatal and is NOT recoverable — the exact no-op that dropped the
  // turn before this PR.
  check(
    "pre-fix ownership skip is NOT recoverable (old fatal classification)",
    isRecoverableNativeHarnessBindingFailure({
      ok: true,
      compacted: false,
      reason: "codex app-server owns automatic compaction",
    } as never) === false,
    "pre-fix ok:true skip bypasses the shared fallback guard",
  );
} finally {
  await client.closeAndWait({ exitTimeoutMs: 5_000, forceKillDelayMs: 250 }).catch(() => {});
}

console.log(
  failures === 0
    ? "\nLIVE LOCKED-PREFLIGHT PROOF OK"
    : `\nLIVE LOCKED-PREFLIGHT PROOF FAILED: ${failures}`,
);
process.exitCode = failures === 0 ? 0 : 1;
