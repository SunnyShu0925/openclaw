/**
 * Session runtime compatibility helpers.
 *
 * Resolves persisted runtime overrides without leaking provider-specific CLI runtime bindings across model routes.
 */
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { isCliRuntimeAliasForProvider } from "./model-runtime-aliases.js";
import { isCliProvider } from "./model-selection.js";

/** Persisted runtime fields used to recover session runtime compatibility. */
type SessionRuntimeCompatEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
>;
type SessionRuntimeOverrideEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
>;

/** Resolves the persisted runtime id, preserving locked transcript ownership. */
export function resolvePersistedSessionRuntimeId(
  entry?: SessionRuntimeCompatEntry,
): string | undefined {
  const harnessRuntime = normalizeOptionalAgentRuntimeId(entry?.agentHarnessId);
  if (
    entry?.modelSelectionLocked === true &&
    harnessRuntime &&
    !isDefaultAgentRuntimeId(harnessRuntime)
  ) {
    return harnessRuntime;
  }
  const runtimeOverride = normalizeOptionalAgentRuntimeId(entry?.agentRuntimeOverride);
  if (runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)) {
    return runtimeOverride;
  }
  return harnessRuntime;
}
/** Resolves a runtime id only when it can serve the selected provider. */
export function resolveCompatibleAgentRuntimeForProvider(params: {
  provider?: string | null;
  runtime?: string | null;
  cfg?: OpenClawConfig;
}): string | undefined {
  const runtime = normalizeOptionalAgentRuntimeId(params.runtime);
  if (!runtime || isDefaultAgentRuntimeId(runtime)) {
    return undefined;
  }
  if (runtime === "openclaw") {
    return runtime;
  }
  const provider = params.provider?.trim().toLowerCase() ?? "";
  // The Codex harness owns both OpenClaw's virtual Codex namespace and canonical OpenAI routes.
  if (runtime === "codex" && (provider === "codex" || provider === "openai")) {
    return runtime;
  }
  return isCliRuntimeAliasForProvider({ provider, runtime, cfg: params.cfg }) ? runtime : undefined;
}
/** Resolves a persisted runtime override only when it can serve the selected provider. */
export function resolveSessionRuntimeOverrideForProvider(params: {
  provider?: string | null;
  entry?: SessionRuntimeOverrideEntry;
  cfg?: OpenClawConfig;
}): string | undefined {
  const lockedHarness = normalizeOptionalAgentRuntimeId(params.entry?.agentHarnessId);
  if (
    params.entry?.modelSelectionLocked === true &&
    lockedHarness &&
    !isDefaultAgentRuntimeId(lockedHarness)
  ) {
    // A locked transcript stays with its creating harness; provider metadata on
    // internal turns must not reinterpret that runtime as a CLI backend.
    return lockedHarness;
  }

  // agentHarnessId records the runtime that produced the existing transcript;
  // it must not override the runtime selected for the next turn.
  return resolveCompatibleAgentRuntimeForProvider({
    provider: params.provider,
    runtime: params.entry?.agentRuntimeOverride,
    cfg: params.cfg,
  });
}

/** Runtime-ownership fields read from a persisted session entry. */
export type SessionRuntimeOwnershipEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
>;

/**
 * Whether a resolved runtime is a CLI runtime for the given provider.
 *
 * Shared by the proactive memory-flush owner and the recovery-path flush
 * admission gate so both paths enforce the same CLI exclusion: a CLI runtime
 * owns its resumable native transcript, so OpenClaw maintenance must not launch
 * a nested memory-writing turn against it. `runtimeId` is the already-resolved
 * agent runtime id (e.g. the embedded runner's `harnessRuntime`); the persisted
 * session-entry runtime is also consulted so a locked transcript runtime is
 * honored even when the explicit id is a default.
 */
export function usesCliRuntime(params: {
  provider: string;
  runtimeId?: string;
  cfg?: OpenClawConfig;
  entry?: SessionRuntimeOwnershipEntry;
}): boolean {
  if (isCliProvider(params.provider, params.cfg)) {
    return true;
  }
  return [resolvePersistedSessionRuntimeId(params.entry), params.runtimeId].some((runtime) =>
    isCliRuntimeAliasForProvider({ provider: params.provider, runtime, cfg: params.cfg }),
  );
}

/**
 * Whether a resolved runtime owns native compaction and must remain the sole
 * compaction owner.
 *
 * Backends that persist resumable native transcripts own their compaction
 * lifecycle; an OpenClaw nested maintenance turn would corrupt that runtime
 * state. Shared by the proactive and recovery flush paths so neither admits a
 * flush against a native-compaction backend.
 */
export function ownsNativeCompaction(params: {
  runtimeId?: string;
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return (
    resolveCliBackendConfig(params.runtimeId ?? "", params.cfg, {
      agentId: params.agentId,
    })?.ownsNativeCompaction === true
  );
}
