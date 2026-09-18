import { describe, expect, it } from "vitest";
import { prepareSessionStoreOwnershipForWrite } from "./io.session-store-owner.js";
import type { OpenClawConfig } from "./types.js";

describe("prepareSessionStoreOwnershipForWrite", () => {
  it("preserves sessionStore.agentId on unrelated write when session.store is unset", () => {
    const currentConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "discord-main" } },
        entries: { "discord-main": { name: "Discord" } },
      },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      agents: {
        ...currentConfig.agents,
        defaults: { ...currentConfig.agents?.defaults, bootstrapMaxChars: 30001 },
      },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: undefined,
      targetConfig,
      env: process.env,
      explicitSetPaths: [["agents", "defaults", "bootstrapMaxChars"]],
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBe("discord-main");
    expect(result.ownershipPaths).toEqual([]);
  });

  it("preserves sessionStore.agentId when both stores use the same {agentId} template", () => {
    const currentConfig: OpenClawConfig = {
      session: { store: "stores/{agentId}/sessions.json" },
      agents: { defaults: { sessionStore: { agentId: "worker-1" } } },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      agents: {
        defaults: { ...currentConfig.agents?.defaults, bootstrapMaxChars: 12000 },
      },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: "stores/{agentId}/sessions.json",
      targetConfig,
      env: process.env,
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBe("worker-1");
    expect(result.ownershipPaths).toEqual([]);
  });

  it("clears sessionStore.agentId on store transition from unset to fixed", () => {
    const currentConfig: OpenClawConfig = {
      agents: { defaults: { sessionStore: { agentId: "discord-main" } } },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      session: { store: "/data/sessions.sqlite" },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: undefined,
      targetConfig,
      env: process.env,
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    expect(result.ownershipPaths).toEqual([["agents", "defaults", "sessionStore", "agentId"]]);
  });

  it("clears sessionStore.agentId on transition between distinct {agentId} templates", () => {
    const currentConfig: OpenClawConfig = {
      session: { store: "/old/{agentId}/sessions.sqlite" },
      agents: { defaults: { sessionStore: { agentId: "discord-main" } } },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      session: { store: "/new/{agentId}/sessions.sqlite" },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: "/old/{agentId}/sessions.sqlite",
      targetConfig,
      env: process.env,
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    expect(result.ownershipPaths).toEqual([["agents", "defaults", "sessionStore", "agentId"]]);
  });

  it("preserves explicitly supplied destination owner during store transition", () => {
    const currentConfig: OpenClawConfig = {
      agents: { defaults: { sessionStore: { agentId: "discord-main" } } },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      session: { store: "stores/{agentId}/sessions.json" },
      agents: { defaults: { sessionStore: { agentId: "anthropic-main" } } },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: undefined,
      targetConfig,
      env: process.env,
      explicitSetPaths: [["agents", "defaults", "sessionStore", "agentId"]],
      explicitSetValueSource: targetConfig,
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBe("anthropic-main");
    expect(result.ownershipPaths).toEqual([]);
  });

  it("clears sessionStore.agentId on transition from template to unset", () => {
    const currentConfig: OpenClawConfig = {
      session: { store: "stores/{agentId}/sessions.json" },
      agents: { defaults: { sessionStore: { agentId: "worker-1" } } },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      session: {},
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: "stores/{agentId}/sessions.json",
      targetConfig,
      env: process.env,
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    expect(result.ownershipPaths).toEqual([["agents", "defaults", "sessionStore", "agentId"]]);
  });
});
