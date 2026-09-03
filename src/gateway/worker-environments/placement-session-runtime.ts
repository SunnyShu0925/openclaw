import { resolveAvailableAgentHarnessPolicy } from "../../agents/harness/availability.js";
import { resolveAutoAgentHarnessId } from "../../agents/harness/support.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
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
 * patch, using projection-mode runtime resolution. Unlike {@link resolveWorkerPlacementSessionRuntime},
 * this does not concretize "auto" to "openclaw", so a model whose effective
 * runtime is undetermined is not falsely treated as placement-compatible.
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
  const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider: selectedModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const policy = resolveAvailableAgentHarnessPolicy({
    mode: "projection",
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(sessionRuntimeOverride ? { agentHarnessRuntimeOverride: sessionRuntimeOverride } : {}),
  });
  // When the policy is "auto", the actual execution path resolves a registered
  // supporting harness via resolveAutoAgentHarnessId before falling back to
  // "openclaw". Mirror that here so a model routed to a placement-capable
  // harness is not falsely rejected. An unclaimed "auto" (no supporting
  // harness) stays unsupported, matching the original bug fix.
  if (policy.runtime === "auto") {
    const autoHarnessId = resolveAutoAgentHarnessId({
      provider: selectedModel.provider,
      modelId: selectedModel.model,
      config: params.cfg,
    });
    return autoHarnessId ? resolveWorkerPlacementCapabilities(autoHarnessId) : {};
  }
  return resolveWorkerPlacementCapabilities(policy.runtime);
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
