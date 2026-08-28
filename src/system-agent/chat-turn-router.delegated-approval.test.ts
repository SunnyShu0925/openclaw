import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { extractToolResultText } from "../agents/embedded-agent-tool-results.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import type { SystemAgentTurnRunner } from "./agent-turn.js";
import { fakeOverviewLoader, SystemAgentChatEngine } from "./chat-engine.test-support.js";

describe("SystemAgentChatEngine delegated approval handoff", () => {
  it("returns the delegated tool handoff through the engine without planner fallback", async () => {
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => {
      const tool = createSystemAgentTool({
        surface: params.surface,
        approvalArmed: params.approvalArmed,
        operatorApprovalOnly: params.operatorApprovalOnly,
        proposalRef: params.session.proposalRef,
      });
      const result = await tool.execute("delegated-proposal", {
        action: "config_set",
        path: "agents.defaults.subagents.thinking",
        value: "high",
      });
      return { text: extractToolResultText(result) ?? "" };
    });
    const planner = vi.fn(async () => {
      throw new Error("planner must not run when the loop replies");
    });
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("switch the thinking level");

    expect(runAgentTurn).toHaveBeenCalledOnce();
    expect(planner).not.toHaveBeenCalled();
    expect(reply.text).toContain("OpenClaw operator UI");
    expect(reply.text).toContain("cannot be applied from this chat");
    expect(reply.text).not.toContain("ask the user to reply yes");
    expect(reply.action).toBe("none");
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set",
      path: "agents.defaults.subagents.thinking",
      value: "high",
    });
  });

  it.each([
    ["config set auth.profiles.invalid true", "Direct config writes cannot change"],
    [
      "config set agents.defaults.model.primary openai/gpt-5.6-luna",
      "Direct config writes cannot change",
    ],
  ])("rejects forbidden delegated plans before offering approval: %s", async (command, error) => {
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => ({ command }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await expect(engine.handle("make the requested change")).rejects.toThrow(error);
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it("tells delegated messaging users an approval can't be applied from chat", async () => {
    const planner = vi.fn(async () => ({
      reply: "Let's point your agent at gpt-5.5.",
      command: "set default model openai/gpt-5.5",
      modelLabel: "claude-cli",
    }));
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("actually use an openai model");

    expect(reply.text).toContain("cannot be applied from this chat");
    expect(reply.text).toContain("OpenClaw operator UI");
    expect(reply.text).toContain("Refused:");
    expect(reply.text).toContain("was not applied from this chat");
    expect(reply.text).not.toContain("Say yes to apply");
    expect(engine.hasPendingProposal()).toBe(true);
  });
});
