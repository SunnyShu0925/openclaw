import { describe, expect, it } from "vitest";
import { resolveModelFallbackAvailability } from "../agents/agent-scope.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

const primaryRef = "openai/gpt-test-primary";
const fallbackRef = "custom/fallback-model";
const catalogEntry = {
  id: "gpt-test-primary",
  name: "gpt-test-primary",
  provider: "openai",
};

const cfg: OpenClawConfig = {
  agents: {
    entries: {
      main: { model: { primary: primaryRef, fallbacks: [fallbackRef] } },
    },
  },
};

const loadCatalog = async () => ({ entries: [catalogEntry], routeVariants: [catalogEntry] });

describe("spawn-owned session creation model provenance", () => {
  it("stores a config-resolved spawn model with auto provenance and fallback origin", async () => {
    await withOpenClawTestState({ label: "spawn-model-auto" }, async () => {
      const created = await createGatewaySession({
        cfg,
        key: "agent:main:dashboard:spawn-auto",
        agentId: "main",
        model: primaryRef,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        creation: {
          via: "spawn",
          actor: { type: "agent", id: "main" },
          spawnModelAutoSelection: {
            provider: "openai",
            model: "gpt-test-primary",
            fallbackOriginProvider: "openai",
            fallbackOriginModel: "gpt-test-primary",
          },
        },
        loadGatewayModelCatalogSnapshot: loadCatalog,
      });
      expect(created.ok, created.ok ? undefined : created.error?.message).toBe(true);
      if (!created.ok) {
        throw new Error(created.error?.message);
      }
      expect(created.entry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-test-primary",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-test-primary",
      });
      const stored = loadSessionEntry({ agentId: "main", sessionKey: created.key });
      expect(stored?.modelOverrideSource).toBe("auto");
      expect(stored).toMatchObject({
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-test-primary",
      });
      // Auto provenance must keep the configured fallback ladder available.
      expect(
        resolveModelFallbackAvailability({
          cfg,
          agentId: "main",
          sessionKey: created.key,
          hasSessionModelOverride: true,
          modelOverrideSource: "auto",
        }),
      ).toEqual({ kind: "active", models: [fallbackRef], source: "explicit" });
    });
  });

  it("keeps a caller-selected model as a user pin that disables fallbacks", async () => {
    await withOpenClawTestState({ label: "spawn-model-user-pin" }, async () => {
      const created = await createGatewaySession({
        cfg,
        key: "agent:main:dashboard:spawn-user-pin",
        agentId: "main",
        model: primaryRef,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        loadGatewayModelCatalogSnapshot: loadCatalog,
      });
      expect(created.ok, created.ok ? undefined : created.error?.message).toBe(true);
      if (!created.ok) {
        throw new Error(created.error?.message);
      }
      expect(created.entry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-test-primary",
        modelOverrideSource: "user",
      });
      expect(created.entry.modelOverrideFallbackOriginProvider).toBeUndefined();
      expect(
        resolveModelFallbackAvailability({
          cfg,
          agentId: "main",
          sessionKey: created.key,
          hasSessionModelOverride: true,
          modelOverrideSource: "user",
        }),
      ).toEqual({ kind: "disabled_by_model_override" });
    });
  });

  it("ignores a trusted auto selection that does not match the stored model", async () => {
    await withOpenClawTestState({ label: "spawn-model-mismatch" }, async () => {
      const created = await createGatewaySession({
        cfg,
        key: "agent:main:dashboard:spawn-mismatch",
        agentId: "main",
        model: primaryRef,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        creation: {
          via: "spawn",
          actor: { type: "agent", id: "main" },
          spawnModelAutoSelection: {
            provider: "openai",
            model: "gpt-other-model",
            fallbackOriginProvider: "openai",
            fallbackOriginModel: "gpt-other-model",
          },
        },
        loadGatewayModelCatalogSnapshot: loadCatalog,
      });
      expect(created.ok, created.ok ? undefined : created.error?.message).toBe(true);
      if (!created.ok) {
        throw new Error(created.error?.message);
      }
      // The stored model wins; unmatched trusted provenance must not restamp origin.
      expect(created.entry).toMatchObject({
        modelOverride: "gpt-test-primary",
      });
      expect(created.entry.modelOverrideFallbackOriginProvider).toBeUndefined();
      expect(created.entry.modelOverrideFallbackOriginModel).toBeUndefined();
    });
  });

  it("routes a visible spawn child onto the subagent fallback ladder, not the agent default", async () => {
    // A visible child is persisted under a dashboard: key, which isSubagentSessionKey
    // does not recognize. But its auto provenance only ever comes from a subagent
    // spawn, so the fallback decision must still consult subagents.model fallbacks.
    const subagentCfg: OpenClawConfig = {
      agents: {
        entries: {
          main: {
            model: { primary: primaryRef, fallbacks: [fallbackRef] },
            subagents: {
              model: {
                primary: "openai/gpt-test-primary",
                fallbacks: ["custom/subagent-fallback"],
              },
            },
          },
        },
      },
    };
    expect(
      resolveModelFallbackAvailability({
        cfg: subagentCfg,
        agentId: "main",
        sessionKey: "agent:main:dashboard:visible-child",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
        subagentFallbackOrigin: true,
      }),
    ).toEqual({ kind: "active", models: ["custom/subagent-fallback"], source: "explicit" });
    // Without the origin flag the same dashboard key falls back to the agent ladder.
    expect(
      resolveModelFallbackAvailability({
        cfg: subagentCfg,
        agentId: "main",
        sessionKey: "agent:main:dashboard:visible-child",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual({ kind: "active", models: [fallbackRef], source: "explicit" });
  });

  it("preserves an auth profile suffix on the wire model without breaking auto provenance", async () => {
    await withOpenClawTestState({ label: "spawn-model-profile" }, async () => {
      const created = await createGatewaySession({
        cfg,
        key: "agent:main:dashboard:spawn-profile",
        agentId: "main",
        // A visible spawn forwards the config-resolved model with its auth profile
        // suffix so the child keeps authProfileOverride instead of dropping it.
        model: `${primaryRef}@work`,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        creation: {
          via: "spawn",
          actor: { type: "agent", id: "main" },
          spawnModelAutoSelection: {
            provider: "openai",
            model: "gpt-test-primary",
            fallbackOriginProvider: "openai",
            fallbackOriginModel: "gpt-test-primary",
          },
        },
        loadGatewayModelCatalogSnapshot: loadCatalog,
      });
      expect(created.ok, created.ok ? undefined : created.error?.message).toBe(true);
      if (!created.ok) {
        throw new Error(created.error?.message);
      }
      expect(created.entry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-test-primary",
        modelOverrideSource: "auto",
        authProfileOverride: "work",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-test-primary",
      });
    });
  });
});

describe("spawn lineage vs legacy auto-fallback provenance", () => {
  it("does not route an ordinary session with legacy auto-fallback onto the subagent ladder", () => {
    // An ordinary (non-spawned) session that has auto-fallback provenance from
    // a prior provider failover must still use the agent ladder, not subagents.model.
    const subagentCfg: OpenClawConfig = {
      agents: {
        entries: {
          main: {
            model: { primary: primaryRef, fallbacks: [fallbackRef] },
            subagents: {
              model: {
                primary: "openai/gpt-test-primary",
                fallbacks: ["custom/subagent-fallback"],
              },
            },
          },
        },
      },
    };
    // Without subagentFallbackOrigin, the dashboard key uses the agent ladder.
    // This is the correct behavior for an ordinary session — it was not spawned.
    expect(
      resolveModelFallbackAvailability({
        cfg: subagentCfg,
        agentId: "main",
        sessionKey: "agent:main:dashboard:ordinary-session",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
        // No subagentFallbackOrigin — ordinary session, even with auto provenance
      }),
    ).toEqual({ kind: "active", models: [fallbackRef], source: "explicit" });
  });
});
