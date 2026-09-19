// Verifies that legacy DM alias normalization in the production preparation
// path does not mutate the caller-owned source config. See #152564 / #152924.

import { beforeEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

describe("validateConfigObjectRawWithPlugins DM alias source preservation", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("preserves the caller-owned Discord config when migrating root dm aliases", () => {
    const source = {
      channels: {
        discord: {
          token: "x",
          dm: { policy: "disabled", allowFrom: ["123456789"] },
        },
      },
    };
    // Deep clone of the authored shape for comparison after validation.
    const authoredSnapshot = structuredClone(source);

    const result = validateConfigObjectRawWithPlugins(source);

    expect(result.ok).toBe(true);
    // The source object the caller handed in must be untouched: the nested
    // `dm` block is still present, and no canonical `dmPolicy` leaked onto it.
    expect(source).toEqual(authoredSnapshot);
    expect(source.channels?.discord?.dm).toEqual({
      policy: "disabled",
      allowFrom: ["123456789"],
    });
    expect(source.channels?.discord).not.toHaveProperty("dmPolicy");
    if (result.ok) {
      // Canonical migration still reaches the validated config.
      expect(result.config.channels?.discord?.dmPolicy).toBe("disabled");
      expect(result.config.channels?.discord?.allowFrom).toEqual(["123456789"]);
    }
  });

  it("preserves the caller-owned Slack config when migrating account-level dm aliases", () => {
    const source = {
      channels: {
        slack: {
          botToken: "x",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["123456789"] } },
          },
        },
      },
    };
    const authoredSnapshot = structuredClone(source);

    const result = validateConfigObjectRawWithPlugins(source);

    expect(result.ok).toBe(true);
    expect(source).toEqual(authoredSnapshot);
    expect(source.channels?.slack?.accounts?.work?.dm).toEqual({
      policy: "disabled",
      allowFrom: ["123456789"],
    });
    expect(source.channels?.slack?.accounts?.work).not.toHaveProperty("dmPolicy");
    if (result.ok) {
      expect(result.config.channels?.slack?.accounts?.work?.dmPolicy).toBe("disabled");
    }
  });

  it("preserves the caller-owned config when validation fails", () => {
    // An unknown nested key under `dm` is rejected by the strict schema, but
    // normalization must not have mutated the source while preparing it.
    const source = {
      channels: {
        discord: {
          token: "x",
          dm: { policy: "disabled", unexpected: true },
        },
      },
    };
    const authoredSnapshot = structuredClone(source);

    const result = validateConfigObjectRawWithPlugins(source);

    expect(result.ok).toBe(false);
    expect(source).toEqual(authoredSnapshot);
  });
});
