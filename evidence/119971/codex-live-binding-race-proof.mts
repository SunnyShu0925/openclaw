// Live evidence for #120197 P1: binding change between the initial read and
// the guarded native request must surface as a canonical recoverable
// stale-binding failure so required-preflight compaction falls back to the
// context engine instead of dropping the user turn.
import { mkdir } from "node:fs/promises";
import { maybeCompactCodexAppServerSession } from "../../extensions/codex/src/app-server/compact.js";
import { resolveCodexAppServerRuntimeOptions } from "../../extensions/codex/src/app-server/config.js";
import {
  registerCodexTestSessionIdentity,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "../../extensions/codex/src/app-server/session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "../../extensions/codex/src/app-server/shared-client.js";
import { isRecoverableNativeHarnessBindingFailure } from "../../src/agents/harness/compaction-recovery.js";

const root = "/tmp/codex-live-binding-race";
const agentDir = root + "/agent";
const sessionFile = root + "/session.jsonl";
const sessionId = "live-race-session-1";
const sessionKey = "agent:main:live-race-session-1";

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

  registerCodexTestSessionIdentity(sessionFile, sessionId, sessionKey, "main");
  await writeCodexAppServerBinding(sessionFile, {
    threadId,
    cwd: root,
    authProfileId: "live",
    clientId: "live-client",
  });

  // Simulate the preflight race: the initial binding read sees the real
  // thread, then the binding store is swapped to a different thread before
  // the guarded native request consults it again.
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
  // Preserve prototype methods (addNotificationHandler/close/...) while
  // wrapping request to observe whether thread/compact/start is issued.
  const clientWithProbe = Object.create(client) as {
    request(method: string, ...args: unknown[]): Promise<unknown>;
  };
  clientWithProbe.request = async (method: string, ...args: unknown[]) => {
    compactRequests.push(method);
    return (client as any).request(method, ...args);
  };

  const result = await maybeCompactCodexAppServerSession(
    {
      sessionId,
      sessionKey,
      sessionFile,
      workspaceDir: root,
      provider: "openai",
      model: modelId,
      trigger: "budget",
      preflightRequired: true,
      currentTokenCount: 456,
    } as never,
    {
      bindingStore,
      allowNonManualNativeRequest: true,
      nativeCompactionRequest: "required_preflight",
      clientFactory: async () => clientWithProbe as never,
      nativeCompletionTimeoutMs: 60_000,
      nativeInterruptGraceMs: 1_000,
    },
  );

  console.log(
    "[live] required-preflight result after binding change:",
    JSON.stringify({
      ok: result?.ok,
      compacted: result?.compacted,
      reason: result?.reason ?? null,
      failureReason: (result as any)?.failure?.reason ?? null,
    }),
  );
  check(
    "binding change returns a canonical stale-binding failure (not an ok:true skip)",
    result?.ok === false &&
      result.compacted === false &&
      result.reason === "codex app-server binding changed before native compaction" &&
      (result as any).failure?.reason === "stale_thread_binding",
    `ok=${result?.ok} compacted=${result?.compacted} reason=${result?.reason ?? "(none)"} failure=${(result as any)?.failure?.reason ?? "(none)"}`,
  );
  check(
    "recoverability guard accepts the new result (context-engine fallback eligible)",
    isRecoverableNativeHarnessBindingFailure(result as never) === true,
    `isRecoverableNativeHarnessBindingFailure=${isRecoverableNativeHarnessBindingFailure(result as never)}`,
  );
  check(
    "pre-fix skip shape is NOT recoverable (would have dropped the turn)",
    isRecoverableNativeHarnessBindingFailure({
      ok: true,
      compacted: false,
      reason: "codex app-server binding changed before native compaction",
    } as never) === false,
    "pre-fix ok:true skip bypasses the shared fallback guard",
  );
  check(
    "no native thread/compact/start was issued on the stale binding",
    !compactRequests.includes("thread/compact/start"),
    `observed requests: ${compactRequests.join(", ") || "(none)"}`,
  );
} finally {
  await client.closeAndWait({ exitTimeoutMs: 5_000, forceKillDelayMs: 250 }).catch(() => {});
}

console.log(
  failures === 0 ? "\nLIVE BINDING-RACE PROOF OK" : `\nLIVE BINDING-RACE PROOF FAILED: ${failures}`,
);
process.exitCode = failures === 0 ? 0 : 1;
