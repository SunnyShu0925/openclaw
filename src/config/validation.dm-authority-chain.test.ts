// Authority-chain regression test for PR #152924 / issue #152564.
// Verifies that nested dm.policy / dm.allowFrom aliases are normalized to
// canonical dmPolicy / allowFrom in the production config preparation path,
// and that the resulting account-level restriction is visible to
// resolveChannelDmAccess — so a forbidden sender is rejected even when the
// channel root default is "open".

import { beforeEach, describe, expect, it } from "vitest";
import { resolveChannelDmAccess } from "../plugin-sdk/channel-config-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

type ChannelEntry = {
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  accounts?: Record<string, Record<string, unknown>>;
};

function resolveChannel(validated: unknown, channelId: string): ChannelEntry | null {
  const root = validated as Record<string, unknown>;
  const channels = root?.channels as Record<string, unknown> | undefined;
  return (channels?.[channelId] as ChannelEntry) ?? null;
}

function resolveAccount(
  validated: unknown,
  channelId: string,
  accountId: string,
): Record<string, unknown> | null {
  const channel = resolveChannel(validated, channelId);
  const accounts = channel?.accounts;
  if (!accounts) {
    return null;
  }
  return (accounts[accountId] as Record<string, unknown>) ?? null;
}

describe("DM alias authority chain — normalization → runtime access resolution", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("rejects a Slack sender when account dm.policy=disabled under root dmPolicy=open", () => {
    const raw = {
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["123456789"] } },
          },
        },
      },
    };

    const result = validateConfigObjectRawWithPlugins(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const channel = resolveChannel(result.config, "slack");
    const account = resolveAccount(result.config, "slack", "work");

    // The account's nested dm.policy is migrated to canonical dmPolicy=disabled.
    expect(account?.dmPolicy).toBe("disabled");
    expect(account?.allowFrom).toEqual(["123456789"]);

    // Runtime access resolution sees the canonical field, not the open root.
    const access = resolveChannelDmAccess({
      account,
      parent: channel,
      mode: "topOnly",
      defaultPolicy: "open",
    });
    expect(access.dmPolicy).toBe("disabled");
  });

  it("rejects a Discord sender when root dm.policy=disabled (alias migration at root scope)", () => {
    const raw = {
      channels: {
        discord: {
          token: "x-proof",
          dm: { policy: "disabled", allowFrom: ["123456789"] },
        },
      },
    };

    const result = validateConfigObjectRawWithPlugins(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const channel = resolveChannel(result.config, "discord");

    // The root nested dm.policy is migrated to canonical dmPolicy=disabled.
    expect(channel?.dmPolicy).toBe("disabled");
    expect(channel?.allowFrom).toEqual(["123456789"]);

    const access = resolveChannelDmAccess({
      account: channel,
      parent: null,
      mode: "topOnly",
      defaultPolicy: "open",
    });
    expect(access.dmPolicy).toBe("disabled");
  });

  it("allows a Slack sender when account dm.policy=open under root dmPolicy=open", () => {
    const raw = {
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "open", allowFrom: ["*"] } },
          },
        },
      },
    };

    const result = validateConfigObjectRawWithPlugins(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const channel = resolveChannel(result.config, "slack");
    const account = resolveAccount(result.config, "slack", "work");

    expect(account?.dmPolicy).toBe("open");

    const access = resolveChannelDmAccess({
      account,
      parent: channel,
      mode: "topOnly",
      defaultPolicy: "open",
    });
    expect(access.dmPolicy).toBe("open");
  });
});

// Admission proof: exercises the full chain from nested DM aliases through
// production normalization to the inbound sender admission function that
// production channel ingress uses to decide allow/block.

// Admission proof: exercises the production channel ingress resolver
// (resolveStableChannelMessageIngress) with the dmPolicy/allowFrom values
// extracted from the normalized config. This is the same function Discord
// and Slack channel handlers call to decide whether to dispatch or reject
// an inbound direct message.
import { resolveStableChannelMessageIngress } from "../plugin-sdk/channel-ingress-runtime.js";

describe("DM alias admission — production ingress resolver with normalized config", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("blocks a forbidden sender when Slack account dm.policy=disabled under root dmPolicy=open", async () => {
    const raw = {
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["123456789"] } },
          },
        },
      },
    };

    const result = validateConfigObjectRawWithPlugins(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const cfg = result.config;
    const account = resolveAccount(cfg, "slack", "work");

    // Normalization migrated the nested alias to canonical dmPolicy=disabled.
    const accountDmPolicy = account?.dmPolicy as string | undefined;
    const accountAllowFrom = account?.allowFrom as Array<string | number> | undefined;
    expect(accountDmPolicy).toBe("disabled");

    const ingress = await resolveStableChannelMessageIngress({
      channelId: "slack",
      accountId: "work",
      subject: { stableId: "999999999" },
      conversation: { kind: "direct", id: "999999999" },
      dmPolicy: accountDmPolicy as "pairing" | "allowlist" | "open" | "disabled",
      allowFrom: accountAllowFrom,
    });

    expect(ingress.senderAccess.decision).toBe("block");
    expect(ingress.senderAccess.allowed).toBe(false);
  });

  it("allows an authorized sender when Slack account dm.policy=allowlist", async () => {
    const raw = {
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "allowlist", allowFrom: ["123456789"] } },
          },
        },
      },
    };

    const result = validateConfigObjectRawWithPlugins(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const cfg = result.config;
    const account = resolveAccount(cfg, "slack", "work");

    const accountDmPolicy = account?.dmPolicy as string | undefined;
    const accountAllowFrom = account?.allowFrom as Array<string | number> | undefined;
    expect(accountDmPolicy).toBe("allowlist");

    const ingress = await resolveStableChannelMessageIngress({
      channelId: "slack",
      accountId: "work",
      subject: { stableId: "123456789" },
      conversation: { kind: "direct", id: "123456789" },
      dmPolicy: accountDmPolicy as "pairing" | "allowlist" | "open" | "disabled",
      allowFrom: accountAllowFrom,
    });

    expect(ingress.senderAccess.allowed).toBe(true);
  });

  it("blocks a forbidden sender when Discord root dm.policy=disabled", async () => {
    const raw = {
      channels: {
        discord: {
          token: "x-proof",
          dm: { policy: "disabled", allowFrom: ["123456789"] },
        },
      },
    };

    const result = validateConfigObjectRawWithPlugins(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const cfg = result.config;
    const channel = resolveChannel(cfg, "discord");

    const channelDmPolicy = channel?.dmPolicy as string | undefined;
    const channelAllowFrom = channel?.allowFrom as Array<string | number> | undefined;
    expect(channelDmPolicy).toBe("disabled");

    const ingress = await resolveStableChannelMessageIngress({
      channelId: "discord",
      accountId: "default",
      subject: { stableId: "999999999" },
      conversation: { kind: "direct", id: "999999999" },
      dmPolicy: channelDmPolicy as "pairing" | "allowlist" | "open" | "disabled",
      allowFrom: channelAllowFrom,
    });

    expect(ingress.senderAccess.decision).toBe("block");
    expect(ingress.senderAccess.allowed).toBe(false);
  });
});
