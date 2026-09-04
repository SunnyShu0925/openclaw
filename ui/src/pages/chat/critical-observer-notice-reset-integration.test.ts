/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
// Integration proof for #137125: drives the PRODUCTION reset path through the
// real session capability (the shared /clear choke point) into the real lazy
// runtime singleton (forgetCriticalObserverTracker), then delivers a
// session.observer digest through the same singleton (handleCriticalObserverDigest)
// and asserts the resulting toast renders. This is the end-to-end app-shell
// flow the focused tracker unit tests do not cover: reset -> bootstrap hook ->
// runtime singleton forget -> observer event -> toast.
//
// Mirrors the bootstrap.ts:273 wiring (onSessionLifecycleReset -> lazy runtime
// forget) and the app-shell-gateway.ts:163 delivery (session.observer ->
// handleCriticalObserverDigest -> showCriticalSessionObserverNotice -> showToast).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import * as criticalObserverRuntime from "./critical-observer-notice.runtime.ts";
import { resetCriticalObserverTracker } from "./critical-observer-notice.runtime.ts";

afterEach(() => {
  document.body.replaceChildren();
  resetCriticalObserverTracker();
});

const SESSION_KEY = "agent:main:other";
const SELECTED_SESSION_KEY = "agent:main:selected";

// Minimal connected gateway snapshot matching the SessionGateway contract the
// capability consumes: a connected client whose `sessions.reset` resolves.
// When simulateSend is true (default), the mock fires onSent before resetImpl,
// matching the real client's behavior after sender.send() succeeds. When false,
// onSent is not fired, simulating a before-send rejection (no socket).
function createConnectedGateway(resetImpl: () => Promise<unknown>, simulateSend = true) {
  const client = {
    request: vi.fn(async (method: string, _params?: unknown, options?: unknown) => {
      if (method === "sessions.reset") {
        if (simulateSend) {
          (options as { onSent?: () => void } | undefined)?.onSent?.();
        }
        await resetImpl();
        return {};
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return { sessions: [], defaults: null, revision: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
  };
  return {
    snapshot: {
      client: client as never,
      phase: "connected" as const,
      hello: null,
      assistantAgentId: "main",
      sessionKey: SELECTED_SESSION_KEY,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  };
}

function deliverObserverDigest(params: { headline: string; health: string; revision: number }) {
  // Same call app-shell-gateway.ts:163 makes on a session.observer event.
  criticalObserverRuntime.handleCriticalObserverDigest({
    payload: {
      sessionKey: SESSION_KEY,
      headline: params.headline,
      health: params.health,
      revision: params.revision,
    },
    selectedSessionKey: SELECTED_SESSION_KEY,
    // sessionHost: {} means no agent-list/main-session defaults — the
    // non-global session key `agent:main:other` is matched directly.
    sessionHost: {},
    sessions: [{ key: SESSION_KEY, label: "Other work", kind: "direct", updatedAt: null }],
    onOpen: vi.fn(),
  });
}

describe("reset -> runtime singleton forget -> observer toast (#137125 integration)", () => {
  it("retires the runtime singleton floor on /clear so a new lifecycle revision 1 announces the toast", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // Bootstrap wiring (verbatim shape of bootstrap.ts:273): the reset hook
    // calls the lazy runtime forget on the document-lifetime singleton.
    const gateway = createConnectedGateway(async () => undefined);
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (key, agentId) => {
          hookFired = true;
          criticalObserverRuntime.forgetCriticalObserverTracker({
            sessionKey: key,
            agentId: agentId ?? undefined,
          });
        },
      },
    );

    // Pre-reset observer digest establishes the revision floor the issue
    // describes (rev 10 stuck) — toast renders and the floor is recorded.
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    // Without the fix: the floor of 10 is retained across reset, so the new
    // lifecycle's revision 1 is rejected as stale and the toast is silently
    // suppressed — exactly the bug #137125 reports. With the fix, the hook
    // retires the floor and revision 1 announces again.
    const result = await sessions.reset(SESSION_KEY, { agentId: undefined });
    expect(result).toBe("completed");
    expect(hookFired).toBe(true);

    deliverObserverDigest({ headline: "Post-reset stuck", health: "stuck", revision: 1 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Post-reset stuck",
    );

    sessions.dispose();
  });

  it("a different session keeps its revision floor across another session's reset", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    const KEPT_KEY = "agent:main:kept";
    const gateway = createConnectedGateway(async () => undefined);
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (key, agentId) => {
          criticalObserverRuntime.forgetCriticalObserverTracker({
            sessionKey: key,
            agentId: agentId ?? undefined,
          });
        },
      },
    );

    // Establish floors on both sessions.
    deliverObserverDigest({ headline: "Pre-reset other", health: "stuck", revision: 10 });
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: KEPT_KEY,
        headline: "Pre-reset kept",
        health: "stuck",
        revision: 10,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost: {},
      sessions: [{ key: KEPT_KEY, label: "Kept", kind: "direct", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Reset ONLY `other` — the kept session's floor must survive.
    await sessions.reset(SESSION_KEY, { agentId: undefined });

    // The reset session's new lifecycle revision 1 announces.
    deliverObserverDigest({ headline: "Post-reset other", health: "stuck", revision: 1 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Post-reset other",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // The kept session's same revision 10 is deduplicated (floor retained) — no toast.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: KEPT_KEY,
        headline: "Replay kept",
        health: "stuck",
        revision: 10,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost: {},
      sessions: [{ key: KEPT_KEY, label: "Kept", kind: "direct", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    sessions.dispose();
  });

  it("retires the floor when a post-commit Gateway error returns ok:false", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // A Gateway response error (ok:false) does not prove the reset was
    // uncommitted — the Gateway writes the new lifecycle before awaited hooks
    // and unbinding can fail and return ok:false. Since the request reached the
    // transport (onSent fired), the floor must be retired to avoid re-introducing
    // the silent revision-1 suppression the fix targets.
    const gatewayError = new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      message: "post-commit hook failed",
    });

    const gateway = createConnectedGateway(async () => {
      throw gatewayError;
    });
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (key, agentId) => {
          hookFired = true;
          criticalObserverRuntime.forgetCriticalObserverTracker({
            sessionKey: key,
            agentId: agentId ?? undefined,
          });
        },
      },
    );

    // Establish the revision floor (rev 10 stuck).
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Reset returns ok:false after the request was sent — hook must fire
    // because the lifecycle may have been replaced before the error.
    const result = await sessions.reset(SESSION_KEY, { agentId: undefined });
    expect(result).toBe("uncertain");
    expect(hookFired).toBe(true);

    // The floor was retired, so a replacement lifecycle revision 1 announces.
    deliverObserverDigest({ headline: "Post-commit stuck", health: "stuck", revision: 1 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Post-commit stuck",
    );

    sessions.dispose();
  });

  it("keeps the revision floor when reset fails before the request is sent (no socket)", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // A local before-send rejection: the socket is unavailable so the request
    // never reaches the Gateway (onSent never fires, requestSent stays false).
    // The lifecycle was NOT replaced, so the floor must survive to deduplicate
    // the same revision.
    const gateway = createConnectedGateway(async () => {
      throw new Error("gateway not connected");
    }, false);
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (key, agentId) => {
          hookFired = true;
          criticalObserverRuntime.forgetCriticalObserverTracker({
            sessionKey: key,
            agentId: agentId ?? undefined,
          });
        },
      },
    );

    // Establish the revision floor (rev 10 stuck).
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Reset fails before the request is sent — hook must NOT fire.
    const result = await sessions.reset(SESSION_KEY, { agentId: undefined });
    expect(result).toBe("uncertain");
    expect(hookFired).toBe(false);

    // Same revision 10 is deduplicated (floor retained) — no duplicate toast.
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    sessions.dispose();
  });

  it("canonicalizes a non-default-agent global alias before retiring the floor (#137917)", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // Configured global scope with a non-default agent: the Home route
    // retains `agent:work:main` (the alias), but the Gateway resets `global`
    // and observer digests arrive as `global` with `agentId: "work"`.
    const ALIAS_KEY = "agent:work:main";
    const CANONICAL_KEY = "global";
    const AGENT_ID = "work";
    const sessionHost = {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "main" }, { id: "work" }],
      },
    };

    // Bootstrap wiring matching bootstrap.ts: canonicalize the raw alias via
    // resolveUiConversationIdentity before forwarding to the tracker forget.
    const gateway = createConnectedGateway(async () => undefined);
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: AGENT_ID }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (key, agentId) => {
          hookFired = true;
          // Mirror bootstrap.ts: resolve the canonical identity so the
          // tracker dedup key matches what record() uses for digests.
          const identity = resolveUiConversationIdentity(sessionHost, key, agentId ?? undefined);
          criticalObserverRuntime.forgetCriticalObserverTracker({
            sessionKey: identity.sessionKey,
            agentId: identity.agentId,
          });
        },
      },
    );

    // Pre-reset observer digest at revision 10 establishes the floor under
    // the canonical key `global:work` — toast renders.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: CANONICAL_KEY,
        agentId: AGENT_ID,
        headline: "Pre-reset stuck",
        health: "stuck",
        revision: 10,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost,
      sessions: [{ key: CANONICAL_KEY, label: "Work session", kind: "global", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Work session — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    // /clear passes the alias `agent:work:main` with `agentId: "work"`.
    // Without canonicalization: forget deletes `agent:work:main` (not stored),
    // leaving the `global:work` floor intact → revision 1 is suppressed.
    // With canonicalization: resolveUiConversationIdentity maps the alias to
    // `{ sessionKey: "global", agentId: "work" }` and forget deletes `global:work`.
    const result = await sessions.reset(ALIAS_KEY, { agentId: AGENT_ID });
    expect(result).toBe("completed");
    expect(hookFired).toBe(true);

    // Post-reset revision 1 must announce — the floor was retired under the
    // canonical key, not the alias.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: CANONICAL_KEY,
        agentId: AGENT_ID,
        headline: "Post-reset stuck",
        health: "stuck",
        revision: 1,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost,
      sessions: [{ key: CANONICAL_KEY, label: "Work session", kind: "global", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Work session — Post-reset stuck",
    );

    sessions.dispose();
  });
});
