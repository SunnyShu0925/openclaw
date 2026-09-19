import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
  validateTestConfigWithPlugins,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSlackAccountConfig, resolveSlackAccountDmPolicy } from "./accounts.js";
import { SlackConfigSchema } from "./config-schema.js";
import type { SlackMonitorContext } from "./monitor/context.js";

describe("slack account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = SlackConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("slack", channel);
    const resolved = {
      ...mergeSlackAccountConfig(cfg, "work"),
      dmPolicy: resolveSlackAccountDmPolicy({ cfg, accountId: "work" }),
    };

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = SlackConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});

describe("Slack account user-token write policy inheritance", () => {
  it.each([
    { root: false, account: {}, expected: false },
    { root: false, account: { userTokenReadOnly: true }, expected: true },
    { root: undefined, account: {}, expected: true },
  ])(
    "resolves root $root and account $account to $expected",
    async ({ root, account, expected }) => {
      const channel = SlackConfigSchema.parse({
        ...(root === undefined ? {} : { userTokenReadOnly: root }),
        accounts: { work: account },
      });
      const cfg = await validateTestChannelConfig("slack", channel);
      const resolved = mergeSlackAccountConfig(cfg, "work");

      expect(resolved.userTokenReadOnly).toBe(expected);
    },
  );
});

// Channel-boundary proof for PR #152924 / issue #152564.
// Raw legacy config (with nested dm.policy/dm.allowFrom) flows through the
// production validation path (validateConfigObjectRawWithPlugins, which runs
// normalizeChannelDmAliasesCopy internally — no pre-parsing) →
// resolveSlackAccountDmPolicy/resolveSlackAccountAllowFrom extracts the
// canonical fields → authorizeSlackSystemEventSender (the real Slack DM
// handler) makes the dispatch/reject decision.
const readChannelIngressStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-ingress-runtime")>();
  return {
    ...actual,
    readChannelIngressStoreAllowFromForDmPolicy: (...args: unknown[]) =>
      readChannelIngressStoreAllowFromForDmPolicyMock(...args),
  };
});

let authorizeSlackSystemEventSender: typeof import("./monitor/auth.js").authorizeSlackSystemEventSender;

beforeAll(async () => {
  ({ authorizeSlackSystemEventSender } = await import("./monitor/auth.js"));
});

beforeEach(() => {
  readChannelIngressStoreAllowFromForDmPolicyMock.mockReset();
  readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue([]);
});

async function validateRawConfig(raw: unknown) {
  return validateTestConfigWithPlugins(raw);
}

function makeCtx(params: {
  dmPolicy: string;
  allowFrom: string[];
  accountId?: string;
}): SlackMonitorContext {
  return {
    allowFrom: params.allowFrom,
    accountId: params.accountId ?? "main",
    dmPolicy: params.dmPolicy,
    dmEnabled: true,
    allowNameMatching: false,
    channelsConfig: {},
    channelsConfigKeys: [],
    defaultRequireMention: true,
    installationIdentity: { kind: "workspace", teamId: "T_MAIN" },
    isChannelAllowed: vi.fn(() => true),
    resolveUserName: vi.fn(async () => ({ name: undefined })),
    resolveChannelName: vi.fn(async () => ({ name: "dm", type: "im" })),
  } as unknown as SlackMonitorContext;
}

describe("DM alias channel-boundary — raw config → production validation → Slack handler", () => {
  it("rejects a forbidden sender when root dm.policy=disabled under open root default", async () => {
    const { resolveSlackAccountAllowFrom } = await import("./accounts.js");
    const cfg = await validateRawConfig({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dm: { policy: "disabled", allowFrom: ["U123456789"] },
        },
      },
    });

    const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: undefined });

    expect(dmPolicy).toBe("disabled");
    expect(allowFrom).toEqual(["U123456789"]);

    const ctx = makeCtx({
      dmPolicy: dmPolicy ?? "pairing",
      allowFrom: allowFrom ?? [],
    });

    const result = await authorizeSlackSystemEventSender({
      ctx,
      senderId: "U999999999",
      channelType: "im",
      channelId: "D999999999",
    });

    expect(result.allowed).toBe(false);
  });

  it("allows an authorized sender when root dm.policy=open with wildcard allowFrom", async () => {
    const { resolveSlackAccountAllowFrom } = await import("./accounts.js");
    const cfg = await validateRawConfig({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dm: { policy: "open", allowFrom: ["*"] },
        },
      },
    });

    const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: undefined });

    expect(dmPolicy).toBe("open");

    const ctx = makeCtx({
      dmPolicy: dmPolicy ?? "pairing",
      allowFrom: allowFrom ?? [],
    });

    const result = await authorizeSlackSystemEventSender({
      ctx,
      senderId: "U123456789",
      channelType: "im",
      channelId: "D123456789",
    });

    expect(result.allowed).toBe(true);
  });

  it("rejects a forbidden sender when account dm.policy=disabled under open root", async () => {
    const { resolveSlackAccountAllowFrom } = await import("./accounts.js");
    const cfg = await validateRawConfig({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["U123456789"] } },
          },
        },
      },
    });

    const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: "work" });
    const allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: "work" });

    expect(dmPolicy).toBe("disabled");
    expect(allowFrom).toEqual(["U123456789"]);

    const ctx = makeCtx({
      dmPolicy: dmPolicy ?? "pairing",
      allowFrom: allowFrom ?? [],
      accountId: "work",
    });

    const result = await authorizeSlackSystemEventSender({
      ctx,
      senderId: "U999999999",
      channelType: "im",
      channelId: "D999999999",
    });

    expect(result.allowed).toBe(false);
  });
});

// Ordinary-DM dispatch boundary proof for PR #152924 / issue #152564.
// ClawSweeper round 5: the system-event path (authorizeSlackSystemEventSender
// above) is not the ordinary DM path. Real direct messages flow through
// authorizeSlackDirectMessage (dm-auth.ts), invoked inside prepareSlackMessage
// (monitor/message-handler/prepare.ts). When it returns false the prepared
// message is null (dropped before dispatch); when true the message proceeds to
// dispatchPreparedSlackMessage. This harness feeds raw legacy nested config
// through the production validation path and then through that ordinary-DM
// authorization function, proving allowed senders proceed and excluded senders
// are dropped at the dispatch boundary — not only at the authorization helper.
const dmAuthUpsertPairingMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor/conversation.runtime.js", () => ({
  upsertChannelPairingRequest: dmAuthUpsertPairingMock,
}));

let authorizeSlackDirectMessage: typeof import("./monitor/dm-auth.js").authorizeSlackDirectMessage;

beforeAll(async () => {
  ({ authorizeSlackDirectMessage } = await import("./monitor/dm-auth.js"));
});

describe("DM alias ordinary-DM dispatch boundary — raw config → production validation → authorizeSlackDirectMessage", () => {
  beforeEach(() => {
    dmAuthUpsertPairingMock.mockReset().mockResolvedValue({
      code: "PAIRCODE",
      created: true,
    });
  });

  it("drops an excluded sender when root dm.policy=disabled under open root default", async () => {
    const { resolveSlackAccountAllowFrom } = await import("./accounts.js");
    const cfg = await validateRawConfig({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dm: { policy: "disabled", allowFrom: ["U123456789"] },
        },
      },
    });

    const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: undefined });

    expect(dmPolicy).toBe("disabled");
    expect(allowFrom).toEqual(["U123456789"]);

    const ctx = makeCtx({
      dmPolicy: dmPolicy ?? "pairing",
      allowFrom: allowFrom ?? [],
    });

    const onDisabled = vi.fn();
    const allowed = await authorizeSlackDirectMessage({
      ctx,
      accountId: "main",
      senderId: "U999999999",
      allowFromLower: (allowFrom ?? []).map((s) => s.toLowerCase()),
      resolveSenderName: vi.fn(async () => ({ name: "attacker" })),
      sendPairingReply: vi.fn(),
      onDisabled,
      onUnauthorized: vi.fn(),
      log: vi.fn(),
    });

    // false → prepareSlackMessage returns null (dropped before dispatch).
    expect(allowed).toBe(false);
    expect(onDisabled).toHaveBeenCalled();
  });

  it("admits an authorized sender when root dm.policy=open with wildcard allowFrom", async () => {
    const { resolveSlackAccountAllowFrom } = await import("./accounts.js");
    const cfg = await validateRawConfig({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dm: { policy: "open", allowFrom: ["*"] },
        },
      },
    });

    const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: undefined });
    const allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: undefined });

    expect(dmPolicy).toBe("open");

    const ctx = makeCtx({
      dmPolicy: dmPolicy ?? "pairing",
      allowFrom: allowFrom ?? [],
    });

    const allowed = await authorizeSlackDirectMessage({
      ctx,
      accountId: "main",
      senderId: "U123456789",
      allowFromLower: (allowFrom ?? []).map((s) => s.toLowerCase()),
      resolveSenderName: vi.fn(async () => ({ name: "owner" })),
      sendPairingReply: vi.fn(),
      onDisabled: vi.fn(),
      onUnauthorized: vi.fn(),
      log: vi.fn(),
    });

    // true → prepareSlackMessage proceeds to dispatchPreparedSlackMessage.
    expect(allowed).toBe(true);
  });

  it("drops an excluded sender when account dm.policy=disabled under open root", async () => {
    const { resolveSlackAccountAllowFrom } = await import("./accounts.js");
    const cfg = await validateRawConfig({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "disabled", allowFrom: ["U123456789"] } },
          },
        },
      },
    });

    const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: "work" });
    const allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: "work" });

    expect(dmPolicy).toBe("disabled");
    expect(allowFrom).toEqual(["U123456789"]);

    const ctx = makeCtx({
      dmPolicy: dmPolicy ?? "pairing",
      allowFrom: allowFrom ?? [],
      accountId: "work",
    });

    const onDisabled = vi.fn();
    const allowed = await authorizeSlackDirectMessage({
      ctx,
      accountId: "work",
      senderId: "U999999999",
      allowFromLower: (allowFrom ?? []).map((s) => s.toLowerCase()),
      resolveSenderName: vi.fn(async () => ({ name: "attacker" })),
      sendPairingReply: vi.fn(),
      onDisabled,
      onUnauthorized: vi.fn(),
      log: vi.fn(),
    });

    // false → dropped at the ordinary-DM dispatch boundary.
    expect(allowed).toBe(false);
    expect(onDisabled).toHaveBeenCalled();
  });

  it("admits an authorized sender when account dm.policy=allowlist under open root", async () => {
    const { resolveSlackAccountAllowFrom } = await import("./accounts.js");
    const cfg = await validateRawConfig({
      channels: {
        slack: {
          botToken: "xoxb-proof",
          appToken: "xapp-proof",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: { dm: { policy: "allowlist", allowFrom: ["U123456789"] } },
          },
        },
      },
    });

    const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: "work" });
    const allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: "work" });

    expect(dmPolicy).toBe("allowlist");
    expect(allowFrom).toEqual(["U123456789"]);

    const ctx = makeCtx({
      dmPolicy: dmPolicy ?? "pairing",
      allowFrom: allowFrom ?? [],
      accountId: "work",
    });

    const allowed = await authorizeSlackDirectMessage({
      ctx,
      accountId: "work",
      senderId: "U123456789",
      allowFromLower: (allowFrom ?? []).map((s) => s.toLowerCase()),
      resolveSenderName: vi.fn(async () => ({ name: "owner" })),
      sendPairingReply: vi.fn(),
      onDisabled: vi.fn(),
      onUnauthorized: vi.fn(),
      log: vi.fn(),
    });

    // true → proceeds to dispatch.
    expect(allowed).toBe(true);
  });
});
