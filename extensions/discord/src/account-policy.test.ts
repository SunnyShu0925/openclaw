import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
  validateTestConfigWithPlugins,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
} from "./accounts.js";
import { DiscordConfigSchema } from "./config-schema.js";

describe("discord account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = DiscordConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("discord", channel);
    const resolved = {
      ...mergeDiscordAccountConfig(cfg, "work"),
      dmPolicy: resolveDiscordAccountDmPolicy({ cfg, accountId: "work" }),
    };

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = DiscordConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});

// Channel-boundary proof for PR #152924 / issue #152564.
// Raw legacy config (with nested dm.policy/dm.allowFrom) flows through the
// production validation path (validateConfigObjectRawWithPlugins, which runs
// normalizeChannelDmAliasesCopy internally — no pre-parsing) →
// resolveDiscordAccountDmPolicy/resolveDiscordAccountAllowFrom extracts the
// canonical fields → resolveDiscordDmCommandAccess (the real Discord DM
// handler) makes the dispatch/reject decision.
import { resolveDiscordDmCommandAccess } from "./monitor/dm-command-auth.js";

const canViewDiscordGuildChannelMock = vi.hoisted(() => vi.fn());

vi.mock("./send.permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send.permissions.js")>();
  return {
    ...actual,
    canViewDiscordGuildChannel: canViewDiscordGuildChannelMock,
  };
});

async function validateRawConfig(raw: unknown) {
  return validateTestConfigWithPlugins(raw);
}

describe("DM alias channel-boundary — raw config → production validation → Discord handler", () => {
  beforeEach(() => {
    canViewDiscordGuildChannelMock.mockReset();
  });

  it("rejects a forbidden sender when root dm.policy=disabled under open root default", async () => {
    const cfg = await validateRawConfig({
      channels: {
        discord: {
          token: "x-proof",
          dm: { policy: "disabled", allowFrom: ["discord:123456789"] },
        },
      },
    });

    const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveDiscordAccountAllowFrom({ cfg, accountId: undefined });

    expect(dmPolicy).toBe("disabled");
    expect(allowFrom).toEqual(["discord:123456789"]);

    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: dmPolicy ?? "pairing",
      configuredAllowFrom: allowFrom ?? [],
      sender: { id: "999999999", name: "attacker", tag: "attacker#0001" },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.allowed).toBe(false);
    expect(result.senderAccess.decision).toBe("block");
  });

  it("allows an authorized sender when root dm.policy=allowlist", async () => {
    const cfg = await validateRawConfig({
      channels: {
        discord: {
          token: "x-proof",
          dm: { policy: "allowlist", allowFrom: ["discord:123456789"] },
        },
      },
    });

    const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveDiscordAccountAllowFrom({ cfg, accountId: undefined });

    expect(dmPolicy).toBe("allowlist");

    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: dmPolicy ?? "pairing",
      configuredAllowFrom: allowFrom ?? [],
      sender: { id: "123456789", name: "owner", tag: "owner#0001" },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.allowed).toBe(true);
    expect(result.senderAccess.decision).toBe("allow");
  });

  it("rejects a forbidden sender when account dm.policy=disabled under open root", async () => {
    const cfg = await validateRawConfig({
      channels: {
        discord: {
          token: "x-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["discord:123456789"] } },
          },
        },
      },
    });

    const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId: "work" });
    const allowFrom = resolveDiscordAccountAllowFrom({ cfg, accountId: "work" });

    expect(dmPolicy).toBe("disabled");
    expect(allowFrom).toEqual(["discord:123456789"]);

    const result = await resolveDiscordDmCommandAccess({
      accountId: "work",
      dmPolicy: dmPolicy ?? "pairing",
      configuredAllowFrom: allowFrom ?? [],
      sender: { id: "999999999", name: "attacker", tag: "attacker#0001" },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.allowed).toBe(false);
    expect(result.senderAccess.decision).toBe("block");
  });
});

// Ordinary-DM dispatch boundary proof for PR #152924 / issue #152564.
// ClawSweeper round 5: authorization helper results alone do not establish
// that excluded senders cannot reach agent dispatch. In the ordinary Discord
// message path, resolveDiscordDmPreflightAccess (monitor/message-handler/
// dm-preflight.ts) calls resolveDiscordDmCommandAccess and then
// handleDiscordDmCommandDecision: when decision is "allow" the prepared
// message proceeds; otherwise the sender is dropped before dispatch. This
// harness feeds raw legacy nested config through the production validation
// path, resolves the canonical DM fields, runs them through the real
// authorization function, and then through the dispatch-decision handler —
// proving allowed senders proceed and excluded senders are dropped at the
// dispatch boundary.
import { handleDiscordDmCommandDecision } from "./monitor/dm-command-decision.js";

const discordPairingMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  upsertChannelPairingRequest: discordPairingMock,
}));

describe("DM alias ordinary-DM dispatch boundary — raw config → production validation → handleDiscordDmCommandDecision", () => {
  beforeEach(() => {
    discordPairingMock.mockReset();
  });

  it("proceeds to dispatch for an authorized sender when root dm.policy=allowlist", async () => {
    const cfg = await validateRawConfig({
      channels: {
        discord: {
          token: "x-proof",
          dm: { policy: "allowlist", allowFrom: ["discord:123456789"] },
        },
      },
    });

    const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveDiscordAccountAllowFrom({ cfg, accountId: undefined });

    const access = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: dmPolicy ?? "pairing",
      configuredAllowFrom: allowFrom ?? [],
      sender: { id: "123456789", name: "owner", tag: "owner#0001" },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(access.senderAccess.decision).toBe("allow");

    // handleDiscordDmCommandDecision returns true → message proceeds to dispatch.
    const proceeds = await handleDiscordDmCommandDecision({
      senderAccess: { decision: access.senderAccess.decision },
      accountId: "default",
      sender: { id: "123456789", name: "owner", tag: "owner#0001" },
      onPairingCreated: vi.fn(),
      onUnauthorized: vi.fn(),
    });

    expect(proceeds).toBe(true);
  });

  it("drops an excluded sender before dispatch when root dm.policy=disabled", async () => {
    const cfg = await validateRawConfig({
      channels: {
        discord: {
          token: "x-proof",
          dm: { policy: "disabled", allowFrom: ["discord:123456789"] },
        },
      },
    });

    const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveDiscordAccountAllowFrom({ cfg, accountId: undefined });

    const access = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: dmPolicy ?? "pairing",
      configuredAllowFrom: allowFrom ?? [],
      sender: { id: "999999999", name: "attacker", tag: "attacker#0001" },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(access.senderAccess.decision).toBe("block");

    const onUnauthorized = vi.fn();
    // handleDiscordDmCommandDecision returns false → dropped before dispatch.
    const proceeds = await handleDiscordDmCommandDecision({
      senderAccess: { decision: access.senderAccess.decision },
      accountId: "default",
      sender: { id: "999999999", name: "attacker", tag: "attacker#0001" },
      onPairingCreated: vi.fn(),
      onUnauthorized,
    });

    expect(proceeds).toBe(false);
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("drops an excluded sender before dispatch when account dm.policy=disabled under open root", async () => {
    const cfg = await validateRawConfig({
      channels: {
        discord: {
          token: "x-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["discord:123456789"] } },
          },
        },
      },
    });

    const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId: "work" });
    const allowFrom = resolveDiscordAccountAllowFrom({ cfg, accountId: "work" });

    const access = await resolveDiscordDmCommandAccess({
      accountId: "work",
      dmPolicy: dmPolicy ?? "pairing",
      configuredAllowFrom: allowFrom ?? [],
      sender: { id: "999999999", name: "attacker", tag: "attacker#0001" },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(access.senderAccess.decision).toBe("block");

    // handleDiscordDmCommandDecision returns false → dropped before dispatch.
    const proceeds = await handleDiscordDmCommandDecision({
      senderAccess: { decision: access.senderAccess.decision },
      accountId: "work",
      sender: { id: "999999999", name: "attacker", tag: "attacker#0001" },
      onPairingCreated: vi.fn(),
      onUnauthorized: vi.fn(),
    });

    expect(proceeds).toBe(false);
  });
});
