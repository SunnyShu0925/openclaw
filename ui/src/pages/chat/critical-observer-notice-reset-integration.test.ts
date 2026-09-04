/* @vitest-environment jsdom */

import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "@openclaw/gateway-client/browser";
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
function createConnectedGateway(resetImpl: () => Promise<unknown>) {
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
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
    const sessions = createSessionCapability(gateway as never, {
      onSessionLifecycleReset: (key, agentId) => {
        hookFired = true;
        criticalObserverRuntime.forgetCriticalObserverTracker({
          sessionKey: key,
          agentId: agentId ?? undefined,
        });
      },
    });

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
    const sessions = createSessionCapability(gateway as never, {
      onSessionLifecycleReset: (key, agentId) => {
        criticalObserverRuntime.forgetCriticalObserverTracker({
          sessionKey: key,
          agentId: agentId ?? undefined,
        });
      },
    });

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

  it("keeps the revision floor when reset is rejected by a Gateway response error", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // A definite Gateway response error (ok: false) — the lifecycle was NOT
    // replaced, so the floor must survive to deduplicate the same revision.
    const gatewayError = new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      message: "reset service unavailable",
    });
    retainGatewayResponsePayload(gatewayError, undefined);

    const gateway = createConnectedGateway(async () => {
      throw gatewayError;
    });
    let hookFired = false;
    const sessions = createSessionCapability(gateway as never, {
      onSessionLifecycleReset: (key, agentId) => {
        hookFired = true;
        criticalObserverRuntime.forgetCriticalObserverTracker({
          sessionKey: key,
          agentId: agentId ?? undefined,
        });
      },
    });

    // Establish the revision floor (rev 10 stuck).
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Reset fails with a Gateway response error — hook must NOT fire.
    const result = await sessions.reset(SESSION_KEY, { agentId: undefined });
    expect(result).toBe("uncertain");
    expect(hookFired).toBe(false);

    // Same revision 10 is deduplicated (floor retained) — no duplicate toast.
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    sessions.dispose();
  });
});
