/**
 * Mock-gateway harness for the terminal exec-approval gate.
 *
 * Exercises the production default policy resolver and approval requester
 * while mocking only the gateway transport, then asserts the exact request
 * payload the terminal tool sends to `exec.approval.request`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals.js";
import { callGatewayTool } from "./gateway.js";
import { createTerminalTool } from "./terminal-tool.js";

vi.mock("./gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function makeBackend() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    pid: 4242,
    write: () => undefined,
    resize: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    kill: () => undefined,
    onData: (listener: (data: string) => void) => {
      onData = listener;
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      onExit = listener;
    },
    emitData: (data: string) => onData?.(data),
    emitExit: (code: number) => onExit?.({ exitCode: code }),
  };
}

function makeAskContext(manager: TerminalSessionManager) {
  const cfg: OpenClawConfig = { tools: { exec: { security: "allowlist", ask: "always" } } };
  return {
    terminalSessions: manager,
    isTerminalEnabled: () => true,
    resolveTerminalLaunchPolicy: () => ({
      ok: true as const,
      plan: {
        agentId: "main",
        cwd: "/tmp",
        shell: "/bin/sh",
        args: [],
      },
    }),
    getRuntimeConfig: () => cfg,
  };
}

describe("terminal exec-approval harness", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("registers a bounded allow-once approval before opening the PTY", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "terminal-approval-1", expiresAtMs: 123 })
      .mockResolvedValueOnce({ decision: "allow-once" });
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => makeBackend(),
    });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      execApprovals: { version: 1 },
      getGatewayContext: () => makeAskContext(manager),
    });

    const opened = await tool.execute("open", { action: "open" });

    expect(opened.details).toMatchObject({ ok: true });
    expect(manager.size).toBe(1);
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);

    const [requestMethod, requestOptions, requestPayload] = mockCallGatewayTool.mock.calls[0] as [
      string,
      { timeoutMs?: number },
      Record<string, unknown>,
    ];
    expect(requestMethod).toBe("exec.approval.request");
    expect(requestOptions.timeoutMs).toBe(DEFAULT_EXEC_APPROVAL_TIMEOUT_MS + 10_000);
    expect(requestPayload).toMatchObject({
      command: expect.stringContaining("terminal: open interactive shell"),
      commandArgv: ["/bin/sh"],
      host: "gateway",
      cwd: "/tmp",
      security: "allowlist",
      ask: "always",
      unavailableDecisions: ["allow-always"],
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: null,
      timeoutMs: DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
      twoPhase: true,
    });

    const [waitMethod, , waitParams] = mockCallGatewayTool.mock.calls[1] as [
      string,
      unknown,
      { id?: string },
    ];
    expect(waitMethod).toBe("exec.approval.waitDecision");
    expect(waitParams.id).toBe("terminal-approval-1");
  });

  it("denies the open when the approval decision is not allow-once", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "terminal-approval-2", expiresAtMs: 123 })
      .mockResolvedValueOnce({ decision: "deny" });
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      execApprovals: { version: 1 },
      getGatewayContext: () => makeAskContext(manager),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "exec approval not granted",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });
});
