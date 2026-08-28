/** Tests ACP metadata session-key resolution against Gateway defaults and lookups. */
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { parseSessionMeta, resetSessionIfNeeded, resolveAcpSessionKey } from "./session-mapper.js";

function createGateway(
  resolvedKey = "agent:main:label",
  resolvedAgentId?: string,
): {
  gateway: GatewayClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "sessions.resolve") {
      return {
        ok: true,
        key: resolvedKey,
        ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
      };
    }
    return { ok: true };
  });

  return {
    gateway: { request } as unknown as GatewayClient,
    request,
  };
}

describe("acp session mapper", () => {
  it("prefers explicit sessionLabel over sessionKey", async () => {
    const { gateway, request } = createGateway("agent:main:label");
    const meta = parseSessionMeta({
      sessionLabel: "support",
      sessionKey: "agent:main:main",
    });

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(result).toEqual({ sessionKey: "agent:main:label" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.resolve", {
      label: "support",
    });
  });

  it("lets meta sessionKey override default label", async () => {
    const { gateway, request } = createGateway("agent:main:label");
    const meta = parseSessionMeta({ sessionKey: "agent:main:override" });

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: { defaultSessionLabel: "default-label" },
    });

    expect(result).toEqual({ sessionKey: "agent:main:override" });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves agentId from sessions.resolve when resolving by label", async () => {
    const { gateway } = createGateway("global", "ops");
    const meta = parseSessionMeta({ sessionLabel: "ops-main" });

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(result).toEqual({ sessionKey: "global", agentId: "ops" });
  });

  it("preserves agentId from sessions.resolve when resolving by key with requireExisting", async () => {
    const { gateway } = createGateway("global", "ops");
    const meta = parseSessionMeta({
      sessionKey: "agent:ops:main",
      requireExistingSession: true,
    });

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(result).toEqual({ sessionKey: "global", agentId: "ops" });
  });

  it("omits agentId when sessions.resolve does not return one", async () => {
    const { gateway } = createGateway("agent:main:label");
    const meta = parseSessionMeta({ sessionLabel: "support" });

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(result).toEqual({ sessionKey: "agent:main:label" });
    expect(result.agentId).toBeUndefined();
  });

  it("omits agentId when requireExisting is false (no resolve call)", async () => {
    const { gateway, request } = createGateway("agent:main:label");
    const meta = parseSessionMeta({ sessionKey: "agent:main:override" });

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(result).toEqual({ sessionKey: "agent:main:override" });
    expect(result.agentId).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("returns fallback without agentId when no key or label is provided", async () => {
    const { gateway, request } = createGateway("agent:main:label");
    const meta = parseSessionMeta({});

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(result).toEqual({ sessionKey: "acp:fallback" });
    expect(result.agentId).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves agentId from default label resolution", async () => {
    const { gateway } = createGateway("global", "ops");
    const meta = parseSessionMeta({});

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: { defaultSessionLabel: "ops-main" },
    });

    expect(result).toEqual({ sessionKey: "global", agentId: "ops" });
  });

  it("preserves agentId from default key resolution with requireExisting", async () => {
    const { gateway } = createGateway("global", "research");
    const meta = parseSessionMeta({});

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {
        defaultSessionKey: "agent:research:main",
        requireExistingSession: true,
      },
    });

    expect(result).toEqual({ sessionKey: "global", agentId: "research" });
  });
});

describe("resetSessionIfNeeded", () => {
  it("carries the provided agentId into sessions.reset", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const gateway = { request } as unknown as GatewayClient;

    await resetSessionIfNeeded({
      meta: parseSessionMeta({ resetSession: true }),
      sessionKey: "global",
      agentId: "ops",
      gateway,
      opts: {},
    });

    expect(request).toHaveBeenCalledWith("sessions.reset", {
      key: "global",
      agentId: "ops",
    });
  });

  it("omits agentId when not provided", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const gateway = { request } as unknown as GatewayClient;

    await resetSessionIfNeeded({
      meta: parseSessionMeta({ resetSession: true }),
      sessionKey: "global",
      gateway,
      opts: {},
    });

    expect(request).toHaveBeenCalledWith("sessions.reset", {
      key: "global",
    });
  });

  it("does not call sessions.reset when resetSession is false", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const gateway = { request } as unknown as GatewayClient;

    await resetSessionIfNeeded({
      meta: parseSessionMeta({}),
      sessionKey: "global",
      agentId: "ops",
      gateway,
      opts: {},
    });

    expect(request).not.toHaveBeenCalled();
  });
});

describe("resolveAcpSessionKey reroute owner clearing", () => {
  it("returns no agentId for explicit sessionKey without requireExisting (reroute scenario)", async () => {
    const { gateway } = createGateway("global", "ops");
    const meta = parseSessionMeta({ sessionKey: "agent:research:main" });

    const result = await resolveAcpSessionKey({
      meta,
      fallbackKey: "global",
      gateway,
      opts: {},
    });

    expect(result).toEqual({ sessionKey: "agent:research:main" });
    expect(result.agentId).toBeUndefined();
  });
});
