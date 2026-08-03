/**
 * Session key resolution helpers.
 *
 * Normalizes display/internal/current-session aliases and resolves session-id inputs through Gateway.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  normalizeGatewayClientId,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logWarn } from "../../logger.js";
import {
  listSpawnedSessionKeysWithResult,
  lookupFailedDenialSuffix,
} from "../../plugin-sdk/session-visibility-internal.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import {
  isAcpSessionKey,
  isIncognitoSessionKey,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";

type GatewayCaller = AgentToolGatewayRequestCaller;

const CURRENT_SESSION_CLIENT_ALIAS_IDS = new Set<string>([
  GATEWAY_CLIENT_IDS.TUI,
  GATEWAY_CLIENT_IDS.CLI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

export function resolveMainSessionAlias(cfg: OpenClawConfig) {
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const alias = scope === "global" ? "global" : mainKey;
  return { mainKey, alias, scope };
}

export function resolveDisplaySessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === params.alias) {
    return "main";
  }
  if (params.key === params.mainKey) {
    return "main";
  }
  return params.key;
}

export function resolveInternalSessionKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
}) {
  if (params.key === "current") {
    return params.requesterInternalKey ?? params.key;
  }
  if (params.key === "main") {
    return params.alias;
  }
  return params.key;
}

export function resolveCurrentSessionClientAlias(params: {
  key: string;
  requesterInternalKey?: string;
}): string | undefined {
  const requesterKey = normalizeOptionalString(params.requesterInternalKey);
  if (!requesterKey) {
    return undefined;
  }
  const clientId = normalizeGatewayClientId(params.key);
  if (!clientId || !CURRENT_SESSION_CLIENT_ALIAS_IDS.has(clientId)) {
    return undefined;
  }
  // UI/client labels can appear next to the real session key in status text.
  // Treat them as the current requester instead of probing them as sessionIds.
  return requesterKey;
}

type SpawnedVisibilityOutcome =
  | { kind: "visible" }
  | { kind: "not-owned" }
  | { kind: "lookup-failed"; retryable: boolean };

/**
 * Detects the expected "No session found" miss from the speculative
 * `sessions.resolve` probe in {@link isRequesterSpawnedSessionVisible}. A valid
 * target outside the requester's spawned set is a normal policy miss, not an
 * operational lookup failure, so it must not trigger the warn trail (review P2).
 */
function isExpectedSessionResolveMiss(error: unknown): boolean {
  if (!(error instanceof GatewayClientRequestError)) {
    return false;
  }
  if (error.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  return Boolean(error.message?.includes("No session found"));
}

async function isRequesterSpawnedSessionVisible(params: {
  requesterSessionKey: string;
  requesterAgentId: string;
  targetSessionKey: string;
  targetAgentId?: string;
  callGateway?: GatewayCaller;
}): Promise<SpawnedVisibilityOutcome> {
  if (
    params.requesterSessionKey === params.targetSessionKey &&
    params.targetAgentId === params.requesterAgentId
  ) {
    return { kind: "visible" };
  }
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  try {
    // A successful no-match is a policy miss. Operational failures remain
    // distinct and observable instead of collapsing into a denial.
    const resolved = await requestResolvedSession(
      {
        key: params.targetSessionKey,
        agentId: params.targetAgentId,
        spawnedBy: params.requesterSessionKey,
        allowMissing: true,
      },
      gatewayCall,
    );
    if (resolved?.key === params.targetSessionKey) {
      return { kind: "visible" };
    }
  } catch (error) {
    // A valid target outside the requester's spawned set is an EXPECTED miss
    // on this speculative probe (the resolver deliberately falls back to
    // `sessions.list` below). On newer gateways `allowMissing: true` makes the
    // server return a successful no-match response so no error is thrown; on
    // older gateways that reject the additive field the retry surfaces the
    // normal "No session found" INVALID_REQUEST. Either way this is not an
    // operational lookup failure, so suppress the warn and fall back quietly —
    // logging it would bury the real failures this PR is meant to diagnose
    // (review P2). Only a genuine transport/credential error is logged.
    if (!isExpectedSessionResolveMiss(error)) {
      logWarn(
        `sessions-resolution: sessions.resolve threw for requester=${params.requesterSessionKey} target=${params.targetSessionKey}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const result = await listSpawnedSessionKeysWithResult({
    requesterSessionKey: params.requesterSessionKey,
    callGateway: gatewayCall,
  });
  // A failed lookup fail-closes as a distinct outcome carrying retryability, so
  // a transient transport failure (retry) is distinguishable from a permanent
  // credential/configuration failure (do not retry); it must not collapse into
  // the generic sandboxed-session denial (review P1: classify before prescribing retry).
  if (!result.ok) {
    return { kind: "lookup-failed", retryable: result.retryable };
  }
  return (!params.targetAgentId || params.targetAgentId === params.requesterAgentId) &&
    result.keys.has(params.targetSessionKey)
    ? { kind: "visible" }
    : { kind: "not-owned" };
}

function looksLikeSessionKey(value: string): boolean {
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return false;
  }
  // These are canonical key shapes that should never be treated as sessionIds.
  if (raw === "main" || raw === "global" || raw === "unknown" || raw === "current") {
    return true;
  }
  if (isAcpSessionKey(raw)) {
    return true;
  }
  if (raw.startsWith("agent:")) {
    return true;
  }
  if (raw.startsWith("cron:") || raw.startsWith("hook:")) {
    return true;
  }
  if (raw.startsWith("node-") || raw.startsWith("node:")) {
    return true;
  }
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return true;
  }
  return false;
}

export function shouldResolveSessionIdInput(value: string): boolean {
  // Treat anything that doesn't look like a well-formed key as a sessionId candidate.
  return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}

type SessionReferenceResolution =
  | {
      ok: true;
      agentId?: string;
      key: string;
      displayKey: string;
      resolvedViaSessionId: boolean;
    }
  | { ok: false; status: "error" | "forbidden"; error: string };

type VisibleSessionReferenceResolution =
  | {
      ok: true;
      agentId?: string;
      key: string;
      displayKey: string;
      missing?: true;
    }
  | {
      ok: false;
      status: "error" | "forbidden";
      error: string;
      displayKey: string;
    };

function resolutionActionPrefix(action: "history" | "send" | "status" | "list"): string {
  if (action === "history") {
    return "Session history";
  }
  if (action === "send") {
    return "Session send";
  }
  if (action === "status") {
    return "Session status";
  }
  return "Session list";
}

function buildResolvedSessionReference(params: {
  agentId?: string;
  key: string;
  alias: string;
  mainKey: string;
  resolvedViaSessionId: boolean;
}): Extract<SessionReferenceResolution, { ok: true }> {
  return {
    ok: true,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    key: params.key,
    displayKey: resolveDisplaySessionKey({
      key: params.key,
      alias: params.alias,
      mainKey: params.mainKey,
    }),
    resolvedViaSessionId: params.resolvedViaSessionId,
  };
}

function buildFailedSessionReference(
  error: unknown,
  raw: string,
  restrictToSpawned: boolean,
): Extract<SessionReferenceResolution, { ok: false }> {
  return restrictToSpawned
    ? {
        ok: false,
        status: "forbidden",
        error: `Session not visible from this sandboxed agent session: ${raw}`,
      }
    : {
        ok: false,
        status: "error",
        error:
          formatErrorMessage(error) ||
          `Session not found: ${raw} (use the full sessionKey from sessions_list)`,
      };
}

async function requestResolvedSession(
  params: Record<string, unknown> & { allowMissing?: boolean },
  callGateway: GatewayCaller,
): Promise<{ agentId?: string; key: string } | undefined> {
  const toResolvedSession = (result: { agentId?: unknown; key?: unknown } | undefined) => {
    const key = normalizeOptionalString(result?.key);
    if (!key) {
      return undefined;
    }
    const agentId = normalizeOptionalString(result?.agentId);
    return { key, ...(agentId ? { agentId } : {}) };
  };
  const result = await callGateway<{ agentId?: unknown; key?: unknown }>({
    method: "sessions.resolve",
    params,
  });
  return toResolvedSession(result);
}

function buildSessionResolveQuery(params: {
  input: string;
  kind: "key" | "sessionId";
  agentId?: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Record<string, unknown> & { allowMissing?: boolean } {
  return {
    [params.kind]: params.input,
    agentId: params.agentId,
    spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
    ...(params.kind === "sessionId"
      ? {
          includeGlobal: !params.restrictToSpawned,
          includeUnknown: !params.restrictToSpawned,
        }
      : {}),
    ...(params.allowMissing ? { allowMissing: true } : {}),
  };
}

export async function resolveSessionReference(params: {
  sessionKey: string;
  /** Owner already selected for literal key lookup; session-id lookup remains cross-agent. */
  keyAgentId?: string;
  agentId?: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  callGateway?: GatewayCaller;
}): Promise<SessionReferenceResolution> {
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  const buildReference = (
    resolved: { agentId?: string; key: string },
    resolvedViaSessionId: boolean,
  ) =>
    buildResolvedSessionReference({
      ...resolved,
      alias: params.alias,
      mainKey: params.mainKey,
      resolvedViaSessionId,
    });
  const tryResolve = async (input: string, kind: "key" | "sessionId", allowMissing = false) => {
    try {
      const resolved = await requestResolvedSession(
        buildSessionResolveQuery({
          input,
          kind,
          agentId:
            kind === "key"
              ? (parseAgentSessionKey(input)?.agentId ?? params.keyAgentId ?? params.agentId)
              : params.agentId,
          requesterInternalKey: params.requesterInternalKey,
          restrictToSpawned: params.restrictToSpawned,
          allowMissing,
        }),
        gatewayCall,
      );
      return resolved ? buildReference(resolved, kind === "sessionId") : null;
    } catch {
      return null;
    }
  };
  const rawInput =
    resolveCurrentSessionClientAlias({
      key: params.sessionKey,
      requesterInternalKey: params.requesterInternalKey,
    }) ?? params.sessionKey.trim();
  const raw =
    rawInput === "current" && params.requesterInternalKey ? params.requesterInternalKey : rawInput;
  if (shouldResolveSessionIdInput(raw)) {
    const resolvedByKey = await tryResolve(raw, "key");
    if (resolvedByKey) {
      return resolvedByKey;
    }
    try {
      const resolved = await requestResolvedSession(
        buildSessionResolveQuery({
          input: raw,
          kind: "sessionId",
          agentId: params.agentId,
          requesterInternalKey: params.requesterInternalKey,
          restrictToSpawned: params.restrictToSpawned,
        }),
        gatewayCall,
      );
      if (!resolved) {
        throw new Error(`Session not found: ${raw} (use the full sessionKey from sessions_list)`);
      }
      return buildReference(resolved, true);
    } catch (error) {
      return buildFailedSessionReference(error, raw, params.restrictToSpawned);
    }
  }

  const resolvedKey = resolveInternalSessionKey({
    key: raw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });
  const semanticAliasAgentId =
    params.agentId ??
    (rawInput === "current"
      ? (parseAgentSessionKey(resolvedKey)?.agentId ?? params.keyAgentId)
      : rawInput === "main" || rawInput === params.mainKey
        ? params.keyAgentId
        : undefined);
  return buildReference(
    { key: resolvedKey, ...(semanticAliasAgentId ? { agentId: semanticAliasAgentId } : {}) },
    false,
  );
}

export async function resolveVisibleSessionReference(params: {
  action: "history" | "send" | "status" | "list";
  resolvedSession: Extract<SessionReferenceResolution, { ok: true }>;
  requesterSessionKey: string;
  requesterAgentId: string;
  restrictToSpawned: boolean;
  visibilitySessionKey: string;
  allowMissingKey?: boolean;
  concealResolutionError?: string;
  callGateway?: GatewayCaller;
}): Promise<VisibleSessionReferenceResolution> {
  let resolvedKey = params.resolvedSession.key;
  let resolvedAgentId =
    params.resolvedSession.agentId ?? parseAgentSessionKey(resolvedKey)?.agentId;
  let displayKey = params.resolvedSession.displayKey;
  let missing = false;
  let verifiedSpawnedVisibility = false;
  // Cross-session tools persist their results into the caller transcript; an
  // incognito target must remain unreachable even from an incognito requester.
  if (isIncognitoSessionKey(resolvedKey)) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from session tools: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  const input = params.visibilitySessionKey.trim();
  const isExplicitKey =
    !params.resolvedSession.resolvedViaSessionId &&
    input !== "current" &&
    input !== "main" &&
    input !== "global" &&
    input !== "unknown" &&
    !shouldResolveSessionIdInput(input);
  if (isExplicitKey && (params.action === "history" || params.action === "send")) {
    try {
      const resolved = await requestResolvedSession(
        buildSessionResolveQuery({
          input: resolvedKey,
          kind: "key",
          agentId: resolvedAgentId,
          requesterInternalKey: params.requesterSessionKey,
          restrictToSpawned: params.restrictToSpawned,
          allowMissing: params.allowMissingKey,
        }),
        params.callGateway ?? callAgentToolGatewayRequest,
      );
      if (resolved) {
        resolvedKey = resolved.key;
        resolvedAgentId = resolved.agentId ?? parseAgentSessionKey(resolved.key)?.agentId;
        displayKey = resolved.key;
        verifiedSpawnedVisibility = params.restrictToSpawned;
      } else if (params.allowMissingKey) {
        missing = true;
      }
    } catch (error) {
      if (params.concealResolutionError && !params.restrictToSpawned) {
        return {
          ok: false,
          status: "forbidden",
          error: params.concealResolutionError,
          displayKey,
        };
      }
      const failed = buildFailedSessionReference(
        error,
        params.visibilitySessionKey,
        params.restrictToSpawned,
      );
      return { ...failed, displayKey };
    }
  }
  if (isIncognitoSessionKey(resolvedKey)) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from session tools: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  const shouldVerifySpawnedVisibility =
    params.restrictToSpawned &&
    !params.resolvedSession.resolvedViaSessionId &&
    (params.requesterSessionKey !== resolvedKey || resolvedAgentId !== params.requesterAgentId);
  const scopedAccess =
    params.action === "list"
      ? undefined
      : createSessionVisibilityChecker.resolveScopedAccess({
          action: params.action,
          requesterSessionKey: params.requesterSessionKey,
          targetSessionKey: resolvedKey,
        });
  if (!scopedAccess && shouldVerifySpawnedVisibility && !verifiedSpawnedVisibility) {
    const spawnedOutcome = await isRequesterSpawnedSessionVisible({
      requesterSessionKey: params.requesterSessionKey,
      requesterAgentId: params.requesterAgentId,
      targetSessionKey: resolvedKey,
      targetAgentId: resolvedAgentId,
      callGateway: params.callGateway,
    });
    if (spawnedOutcome.kind === "lookup-failed") {
      return {
        ok: false,
        status: "forbidden",
        error: `${resolutionActionPrefix(params.action)} denied because ${lookupFailedDenialSuffix(spawnedOutcome.retryable)}`,
        displayKey,
      };
    }
    if (spawnedOutcome.kind === "not-owned") {
      return {
        ok: false,
        status: "forbidden",
        error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
        displayKey,
      };
    }
  }
  return {
    ok: true,
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    key: resolvedKey,
    displayKey,
    ...(missing ? { missing: true } : {}),
  };
}
