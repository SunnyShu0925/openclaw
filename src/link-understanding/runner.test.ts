// Link-understanding runner tests cover guarded fetches, command execution, scoping, and template behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LinkModelConfig } from "../config/types.tools.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runLinkUnderstanding } from "./runner.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: mocks.runCommandWithTimeout,
  };
});

function cfg(entry: LinkModelConfig) {
  return {
    tools: {
      links: {
        enabled: true,
        models: [entry],
      },
    },
  } as OpenClawConfig;
}

function ctx(body: string): MsgContext {
  return { Body: body } as MsgContext;
}

function mockGuardedFetch(body = "guarded content", finalUrl = "https://example.com/final") {
  const release = vi.fn(async () => {});
  mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(body),
    finalUrl,
    release,
  });
  return release;
}

function mockCommand(stdout = "summary") {
  mocks.runCommandWithTimeout.mockResolvedValueOnce({
    code: 0,
    killed: false,
    signal: null,
    stderr: "",
    stdout,
    termination: "exit",
  });
}

describe("runLinkUnderstanding", () => {
  beforeEach(() => {
    mocks.fetchWithSsrFGuard.mockReset();
    mocks.runCommandWithTimeout.mockReset();
  });

  it("applies shared media scope rules to link message context", async () => {
    const result = await runLinkUnderstanding({
      cfg: {
        tools: {
          links: {
            enabled: true,
            scope: {
              default: "allow",
              rules: [
                {
                  action: "deny",
                  match: { channel: "slack", chatType: "channel", keyPrefix: "agent:main:" },
                },
              ],
            },
            models: [{ type: "cli", command: "summarize" }],
          },
        },
      } as OpenClawConfig,
      ctx: {
        Body: "see https://example.com/page",
        ChatType: "channel",
        Provider: "discord",
        SessionKey: "agent:main:slack:channel:C123",
        Surface: "slack",
      } as MsgContext,
    });

    expect(result).toEqual({ urls: [], outputs: [] });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("fetches links through the SSRF guard before passing content to CLI stdin", async () => {
    const release = mockGuardedFetch("page body", "https://example.com/final");
    mockCommand("summarized page");

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize", args: ["--source", "{{LinkUrl}}"] }),
      ctx: ctx("see https://example.com/page"),
    });

    expect(result.outputs).toEqual(["summarized page"]);
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "link-understanding",
        mode: "strict",
        url: "https://example.com/page",
      }),
    );
    expect(runCommandWithTimeout).toHaveBeenCalledWith(["summarize", "--source"], {
      env: {
        OPENCLAW_LINK_FINAL_URL: "https://example.com/final",
        OPENCLAW_LINK_URL: "https://example.com/page",
      },
      input: "page body",
      timeoutMs: 30000,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not run configured curl fetchers against attacker-controlled URLs", async () => {
    mockGuardedFetch("guarded page body");

    const result = await runLinkUnderstanding({
      cfg: cfg({
        type: "cli",
        command: "curl",
        args: ["-s", "-L", "{{LinkUrl}}"],
      }),
      ctx: ctx("see http://192.168.1.64.nip.io:8888/aws-iam-credentials"),
    });

    expect(result.outputs).toEqual(["guarded page body"]);
    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("skips links rejected by the guarded fetch DNS policy", async () => {
    mocks.fetchWithSsrFGuard.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal/special-use IP address"),
    );

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see http://169.254.169.254.nip.io/latest/meta-data/"),
    });

    expect(result.outputs).toEqual([]);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("skips links rejected by the guarded fetch redirect policy", async () => {
    mocks.fetchWithSsrFGuard.mockRejectedValueOnce(
      new Error("redirect target resolves to private network"),
    );

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see https://public.example/redirect-to-metadata"),
    });

    expect(result.outputs).toEqual([]);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("uses the global link-tools timeout for fetches when configured", async () => {
    mockGuardedFetch("page body", "https://example.com/final");
    mockCommand("summarized page");

    await runLinkUnderstanding({
      cfg: {
        tools: {
          links: {
            enabled: true,
            timeoutSeconds: 15,
            models: [
              { type: "cli", command: "summarize-fast", timeoutSeconds: 1 },
              { type: "cli", command: "summarize-slow", timeoutSeconds: 9 },
            ],
          },
        },
      } as OpenClawConfig,
      ctx: ctx("see https://example.com/page"),
    });

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 15000,
        url: "https://example.com/page",
      }),
    );
  });

  it("falls back to the largest model timeout for fetches when no global timeout is set", async () => {
    mockGuardedFetch("page body", "https://example.com/final");
    mockCommand("summarized page");

    await runLinkUnderstanding({
      cfg: {
        tools: {
          links: {
            enabled: true,
            models: [
              { type: "cli", command: "summarize-fast", timeoutSeconds: 1 },
              { type: "cli", command: "summarize-slow", timeoutSeconds: 9 },
            ],
          },
        },
      } as OpenClawConfig,
      ctx: ctx("see https://example.com/page"),
    });

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 9000,
        url: "https://example.com/page",
      }),
    );
  });

  it("passes the reply AbortSignal to the guarded fetch and CLI runner", async () => {
    const controller = new AbortController();
    mockGuardedFetch("page body", "https://example.com/final");
    mockCommand("summarized page");

    await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see https://example.com/page"),
      signal: controller.signal,
    });

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["summarize"],
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("skips all work when the signal is already aborted before entry", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see https://example.com/page"),
      signal: controller.signal,
    });

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(result.outputs).toEqual([]);
  });

  it("stops processing the second link when the signal aborts after the first link", async () => {
    const controller = new AbortController();
    mockGuardedFetch("first body", "https://example.com/first");
    // Link 1's CLI succeeds and triggers abort; link 2 must not be fetched.
    mocks.runCommandWithTimeout.mockImplementationOnce(async () => {
      controller.abort();
      return {
        code: 0,
        killed: false,
        signal: null,
        stderr: "",
        stdout: "first summary",
        termination: "exit" as const,
      };
    });

    await expect(
      runLinkUnderstanding({
        cfg: cfg({ type: "cli", command: "summarize" }),
        ctx: ctx("see https://example.com/first and https://example.com/second"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // Link 1 fetched and its CLI ran; link 2 was never fetched.
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("passes the signal to each CLI entry in the fallback loop", async () => {
    const controller = new AbortController();
    mockGuardedFetch("page body", "https://example.com/final");
    // First entry returns empty (falsy), second entry succeeds.
    mocks.runCommandWithTimeout.mockResolvedValueOnce({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "",
      termination: "exit",
    });
    mockCommand("second summary");

    await runLinkUnderstanding({
      cfg: {
        tools: {
          links: {
            enabled: true,
            models: [
              { type: "cli", command: "summarize-a" },
              { type: "cli", command: "summarize-b" },
            ],
          },
        },
      } as OpenClawConfig,
      ctx: ctx("see https://example.com/page"),
      signal: controller.signal,
    });

    // Both entries received the signal.
    expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
      1,
      ["summarize-a"],
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
      2,
      ["summarize-b"],
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("does not fold outputs into context when the signal is already aborted", async () => {
    const { applyLinkUnderstanding } = await import("./apply.js");
    const controller = new AbortController();
    controller.abort();

    mockGuardedFetch("page body", "https://example.com/final");
    mockCommand("summary");

    const ctxObj = ctx("see https://example.com/page");
    const result = await applyLinkUnderstanding({
      ctx: ctxObj,
      cfg: cfg({ type: "cli", command: "summarize" }),
      signal: controller.signal,
    });

    // Pre-aborted: fetch never runs, context untouched.
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(ctxObj.LinkUnderstanding).toBeUndefined();
    expect(result.outputs).toEqual([]);
  });
  it("rethrows an AbortError when the CLI command is aborted mid-run", async () => {
    const controller = new AbortController();
    mockGuardedFetch("page body", "https://example.com/final");
    // The CLI returns an abort termination; the signal is aborted during the call.
    mocks.runCommandWithTimeout.mockImplementationOnce(async () => {
      controller.abort();
      return {
        code: null,
        killed: false,
        signal: null,
        stderr: "",
        stdout: "",
        termination: "signal" as const,
      };
    });

    await expect(
      runLinkUnderstanding({
        cfg: cfg({ type: "cli", command: "summarize" }),
        ctx: ctx("see https://example.com/page"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // Only one CLI entry attempted; the AbortError propagated, not degraded.
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("rethrows an AbortError when the guarded fetch is aborted", async () => {
    const controller = new AbortController();
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    mocks.fetchWithSsrFGuard.mockRejectedValueOnce(abortError);

    await expect(
      runLinkUnderstanding({
        cfg: cfg({ type: "cli", command: "summarize" }),
        ctx: ctx("see https://example.com/page"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // CLI never runs because the fetch AbortError propagated.
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("does not fold a late CLI output into results after the signal aborts", async () => {
    const controller = new AbortController();
    mockGuardedFetch("page body", "https://example.com/final");
    // CLI succeeds but we abort right after it returns.
    mocks.runCommandWithTimeout.mockImplementationOnce(async () => {
      controller.abort();
      return {
        code: 0,
        killed: false,
        signal: null,
        stderr: "",
        stdout: "late summary",
        termination: "exit" as const,
      };
    });

    await expect(
      runLinkUnderstanding({
        cfg: cfg({ type: "cli", command: "summarize" }),
        ctx: ctx("see https://example.com/page"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not run the second fallback entry after the first is aborted", async () => {
    const controller = new AbortController();
    mockGuardedFetch("page body", "https://example.com/final");
    mocks.runCommandWithTimeout.mockImplementationOnce(async () => {
      controller.abort();
      return {
        code: null,
        killed: false,
        signal: null,
        stderr: "",
        stdout: "",
        termination: "signal" as const,
      };
    });

    await expect(
      runLinkUnderstanding({
        cfg: {
          tools: {
            links: {
              enabled: true,
              models: [
                { type: "cli", command: "summarize-a" },
                { type: "cli", command: "summarize-b" },
              ],
            },
          },
        } as OpenClawConfig,
        ctx: ctx("see https://example.com/page"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // Only the first entry ran; the AbortError prevented the fallback loop.
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });
  it("treats a fetch failure as cancellation when the signal is already aborted", async () => {
    const controller = new AbortController();
    // The fetch rejects with a non-AbortError shape, but the signal is aborted.
    mocks.fetchWithSsrFGuard.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const result = runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see https://example.com/page"),
      signal: controller.signal,
    });

    // Abort during the fetch rejection — the signal check must win over recovery.
    await vi.waitFor(() => {
      expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    });
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("treats a CLI exit error as cancellation when the signal is already aborted", async () => {
    const controller = new AbortController();
    mockGuardedFetch("page body", "https://example.com/final");
    // CLI exits with error code (not termination "signal"), but signal is aborted.
    mocks.runCommandWithTimeout.mockImplementationOnce(async () => {
      controller.abort();
      return {
        code: 1,
        killed: false,
        signal: null,
        stderr: "some error",
        stdout: "",
        termination: "exit" as const,
      };
    });

    await expect(
      runLinkUnderstanding({
        cfg: cfg({ type: "cli", command: "summarize" }),
        ctx: ctx("see https://example.com/page"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
