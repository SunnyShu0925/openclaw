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
});
