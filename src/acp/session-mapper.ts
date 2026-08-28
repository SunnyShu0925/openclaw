/** Resolves ACP request metadata into OpenClaw Gateway session keys and reset behavior. */
import { readBool, readMetadataString } from "@openclaw/acp-core/meta";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import type { GatewayClient } from "../gateway/client.js";

type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

/** A resolved session key paired with its owner agent when the Gateway provided one. */
export type ResolvedAcpSession = {
  sessionKey: string;
  agentId?: string;
};

/** Parses ACP request metadata into OpenClaw session routing hints. */
export function parseSessionMeta(meta: unknown): AcpSessionMeta {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const record = meta as Record<string, unknown>;
  return {
    sessionKey: readMetadataString(record, ["sessionKey", "session", "key"]),
    sessionLabel: readMetadataString(record, ["sessionLabel", "label"]),
    resetSession: readBool(record, ["resetSession", "reset"]),
    requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
    prefixCwd: readBool(record, ["prefixCwd"]),
  };
}

/** Resolves the Gateway session key for an ACP request using metadata, defaults, or fallback. */
export async function resolveAcpSessionKey(params: {
  meta: AcpSessionMeta;
  fallbackKey: string;
  gateway: GatewayClient;
  opts: AcpServerOptions;
}): Promise<ResolvedAcpSession> {
  const requestedLabel = params.meta.sessionLabel ?? params.opts.defaultSessionLabel;
  const requestedKey = params.meta.sessionKey ?? params.opts.defaultSessionKey;
  const requireExisting =
    params.meta.requireExisting ?? params.opts.requireExistingSession ?? false;

  if (params.meta.sessionLabel) {
    const resolved = await params.gateway.request<{
      ok: true;
      key: string;
      agentId?: string;
    }>("sessions.resolve", {
      label: params.meta.sessionLabel,
    });
    if (!resolved?.key) {
      throw new Error(`Unable to resolve session label: ${params.meta.sessionLabel}`);
    }
    return { sessionKey: resolved.key, agentId: resolved.agentId };
  }

  if (params.meta.sessionKey) {
    if (!requireExisting) {
      return { sessionKey: params.meta.sessionKey };
    }
    const resolved = await params.gateway.request<{
      ok: true;
      key: string;
      agentId?: string;
    }>("sessions.resolve", {
      key: params.meta.sessionKey,
    });
    if (!resolved?.key) {
      throw new Error(`Session key not found: ${params.meta.sessionKey}`);
    }
    return { sessionKey: resolved.key, agentId: resolved.agentId };
  }

  if (requestedLabel) {
    const resolved = await params.gateway.request<{
      ok: true;
      key: string;
      agentId?: string;
    }>("sessions.resolve", {
      label: requestedLabel,
    });
    if (!resolved?.key) {
      throw new Error(`Unable to resolve session label: ${requestedLabel}`);
    }
    return { sessionKey: resolved.key, agentId: resolved.agentId };
  }

  if (requestedKey) {
    if (!requireExisting) {
      return { sessionKey: requestedKey };
    }
    const resolved = await params.gateway.request<{
      ok: true;
      key: string;
      agentId?: string;
    }>("sessions.resolve", {
      key: requestedKey,
    });
    if (!resolved?.key) {
      throw new Error(`Session key not found: ${requestedKey}`);
    }
    return { sessionKey: resolved.key, agentId: resolved.agentId };
  }

  return { sessionKey: params.fallbackKey };
}

/** Sends a Gateway session reset when ACP metadata or server defaults request it. */
export async function resetSessionIfNeeded(params: {
  meta: AcpSessionMeta;
  sessionKey: string;
  agentId?: string;
  gateway: GatewayClient;
  opts: AcpServerOptions;
}): Promise<void> {
  const resetSession = params.meta.resetSession ?? params.opts.resetSession ?? false;
  if (!resetSession) {
    return;
  }
  await params.gateway.request("sessions.reset", {
    key: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}
