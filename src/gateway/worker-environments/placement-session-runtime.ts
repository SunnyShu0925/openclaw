import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

export { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";

export function resolveWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}): string {
  const selectedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
  });
}

export function resolveWorkerPlacementExecutionMode(
  runtime: string,
): WorkerPlacementExecutionMode | undefined {
  return resolveWorkerPlacementCapabilities(runtime).executionMode;
}

/**
 * Resolves placement capabilities for the model a session would use after a
 * patch. Reuses the canonical runtime resolution path
 * ({@link resolveEffectiveAgentRuntime}) instead of duplicating its
 * override/projection/auto-harness/fallback sequence, and consults the same
 * CLI-execution classifier the dispatch path uses
 * ({@link resolveCliRuntimeExecutionProvider} + {@link isCliProvider}, mirroring
 * `inference-route.ts` / `agent-handler-helpers.ts`). A model whose dispatch
 * runs as a local CLI process has no cloud placement capability, so it is
 * rejected before persistence instead of being misread as the built-in
 * `openclaw` worker-turn runtime.
 */
export function resolveWorkerPlacementSessionRuntimeCapabilities(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}): {
  executionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
} {
  const selectedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  // CLI-backed providers execute as local processes (runCliFallbackCandidate) and
  // cannot claim an active cloud worker placement. Resolve the execution provider
  // through the same auth-profile-aware aliasing the dispatch path applies, so the
  // reported CLI-backend case is rejected rather than misread as embedded openclaw.
  const cliExecutionProvider = resolveCliRuntimeExecutionProvider({
    provider: selectedModel.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: selectedModel.model,
  });
  const executionProvider = cliExecutionProvider ?? selectedModel.provider;
  if (isCliProvider(executionProvider, params.cfg)) {
    return {};
  }
  const runtime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
  });
  return resolveWorkerPlacementCapabilities(runtime);
}

export function projectWorkerPlacementAgentRuntime(
  runtime: GatewayAgentRuntime,
): GatewayAgentRuntime & {
  cloudPlacementSupported: boolean;
  cloudPlacementExecutionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
  devicePlacementSupported: boolean;
} {
  const { source, ...identity } = runtime;
  const { executionMode, devicePlacement } = resolveWorkerPlacementCapabilities(runtime.id);
  return {
    ...identity,
    cloudPlacementSupported: executionMode !== undefined,
    ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
    ...(devicePlacement ? { devicePlacement } : {}),
    devicePlacementSupported: devicePlacement !== undefined,
    source,
  };
}
