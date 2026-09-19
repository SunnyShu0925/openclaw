// Upgrade-preservation proof for PR #152924 / issue #152564.
// ClawSweeper round 5: the preparation change (normalizeChannelDmAliasesCopy
// inside prepareConfigObjectWithPlugins) affects existing saved configuration.
// This harness proves that a saved config carrying legacy nested DM aliases,
// when run through the production validation path, preserves account-level
// restrictions, keeps unrelated settings intact, and canonicalizes aliases —
// the behavior upgrade / doctor --fix relies on.
import { beforeEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

describe("validateConfigObjectRawWithPlugins DM alias upgrade preservation", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("preserves unrelated Discord dm settings when migrating root dm aliases", () => {
    const result = validateConfigObjectRawWithPlugins({
      channels: {
        discord: {
          token: "x",
          // Unrelated dm settings that must survive the normalization copy.
          dm: {
            enabled: true,
            groupEnabled: true,
            groupChannels: ["123"],
            policy: "disabled",
            allowFrom: ["discord:123456789"],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const discord = result.config.channels?.discord;
    // Canonical aliases reach the validated config.
    expect(discord?.dmPolicy).toBe("disabled");
    expect(discord?.allowFrom).toEqual(["discord:123456789"]);
    // Unrelated dm settings are preserved.
    expect(discord?.dm?.enabled).toBe(true);
    expect(discord?.dm?.groupEnabled).toBe(true);
    expect(discord?.dm?.groupChannels).toEqual(["123"]);
    // The legacy nested aliases are gone from the validated config.
    expect(discord?.dm).not.toHaveProperty("policy");
    expect(discord?.dm).not.toHaveProperty("allowFrom");
  });

  it("preserves unrelated Slack settings when migrating account-level dm aliases", () => {
    const result = validateConfigObjectRawWithPlugins({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          // Unrelated account setting that must survive normalization.
          userTokenReadOnly: true,
          accounts: {
            work: {
              userTokenReadOnly: false,
              dm: { policy: "disabled", allowFrom: ["U123456789"] },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const slack = result.config.channels?.slack;
    // Root aliases unchanged.
    expect(slack?.dmPolicy).toBe("open");
    expect(slack?.allowFrom).toEqual(["*"]);
    // Account-level nested alias migrated to canonical form.
    expect(slack?.accounts?.work?.dmPolicy).toBe("disabled");
    expect(slack?.accounts?.work?.allowFrom).toEqual(["U123456789"]);
    // Unrelated account setting preserved.
    expect(slack?.accounts?.work?.userTokenReadOnly).toBe(false);
    // Legacy nested aliases gone from the validated account (dm block removed
    // when only policy/allowFrom were present).
    expect(slack?.accounts?.work?.dmPolicy).toBe("disabled");
    expect(slack?.accounts?.work?.allowFrom).toEqual(["U123456789"]);
    expect(slack?.accounts?.work?.dm ?? {}).not.toHaveProperty("policy");
  });

  it("preserves a non-DM channel alongside migrated Discord and Slack aliases", () => {
    // An unrelated channel (telegram) must survive the DM-alias normalization
    // copy untouched.
    const result = validateConfigObjectRawWithPlugins({
      channels: {
        telegram: {
          botToken: "tg-proof",
        },
        discord: {
          token: "x",
          dm: { policy: "open", allowFrom: ["*"] },
        },
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dm: { policy: "disabled", allowFrom: ["U123456789"] },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Unrelated channel preserved.
    expect(result.config.channels?.telegram?.botToken).toBe("tg-proof");
    // Discord alias migrated.
    expect(result.config.channels?.discord?.dmPolicy).toBe("open");
    expect(result.config.channels?.discord?.allowFrom).toEqual(["*"]);
    // Slack alias migrated.
    expect(result.config.channels?.slack?.dmPolicy).toBe("disabled");
    expect(result.config.channels?.slack?.allowFrom).toEqual(["U123456789"]);
  });

  it("preserves account restrictions for multiple accounts under an open root", () => {
    const result = validateConfigObjectRawWithPlugins({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["U111"] } },
            personal: { dm: { policy: "allowlist", allowFrom: ["U222"] } },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const accounts = result.config.channels?.slack?.accounts;
    // Each account's nested alias migrated independently.
    expect(accounts?.work?.dmPolicy).toBe("disabled");
    expect(accounts?.work?.allowFrom).toEqual(["U111"]);
    expect(accounts?.personal?.dmPolicy).toBe("allowlist");
    expect(accounts?.personal?.allowFrom).toEqual(["U222"]);
  });
});
