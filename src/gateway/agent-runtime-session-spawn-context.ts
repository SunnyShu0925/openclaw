/**
 * Config-resolved spawn model provenance carried through the trusted creation
 * context: marks the `model` of a spawn-owned creation as an agent-config
 * selection rather than a caller pin, so the configured fallback ladder stays
 * available for the child.
 */
export type AgentRuntimeSpawnModelAutoSelection = {
  /** Resolved selection provider; omitted when the resolved spawn ref is model-only. */
  provider?: string;
  model: string;
  /** Config-selected primary recorded for auto-fallback recovery; present only when a configured subagents/agent model produced the selection. */
  fallbackOriginProvider?: string;
  fallbackOriginModel?: string;
};

export type AgentRuntimeSessionSpawnContext = {
  completionOwnerSessionKey?: string;
  inheritedToolPolicy: {
    version: 1;
    allow: string[];
    deny: string[];
  };
  spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
};
