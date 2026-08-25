import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest as baseRequest,
  expectTerminalOpen,
  makeFakePty,
} from "./session-manager.test-helpers.js";

describe("TerminalSessionManager shell readiness", () => {
  const SIG = () => new AbortController().signal;
  const PROBE_RE = /^printf '%s\\n' '(__OC_SHELL_READY__:[0-9a-f]+)'\r$/;
  function echoShell(fake: ReturnType<typeof makeFakePty>) {
    fake.write = (data) => {
      fake.writes.push(data);
      const m = data.match(PROBE_RE);
      if (m) {
        queueMicrotask(() => {
          fake.emitData(data.replace(/\r$/, "\r\n"));
          fake.emitData(`${m[1]}\n`);
        });
      }
    };
  }
  async function openSession(
    fake: ReturnType<typeof makeFakePty>,
    req?: Parameters<typeof baseRequest>[0],
  ) {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => fake }),
      owner = agentTerminalOwner("agent:main:main");
    return {
      manager,
      owner,
      sid: expectTerminalOpen(await manager.open(baseRequest({ owner, ...req }))).sessionId,
    };
  }
  it("resolves on the standalone marker line, not the PTY input echo", async () => {
    const fake = makeFakePty();
    echoShell(fake);
    const { manager, owner, sid } = await openSession(fake);
    expect((await manager.awaitShellReady(owner, sid, ["-l"], SIG())).ok).toBe(true);
    expect(fake.writes[0]).toMatch(PROBE_RE);
    expect(manager.snapshotAgent(owner, sid) ?? "").not.toMatch(/__OC_SHELL_READY__/);
    manager.writeAgent(owner, sid, "echo hi\r");
    fake.emitData("hi\n");
    await vi.waitFor(() => expect(manager.snapshotAgent(owner, sid) ?? "").toContain("hi"));
  });
  it("skips the probe for non-login shells (e.g. Windows cmd.exe)", async () => {
    const fake = makeFakePty();
    const { manager, owner, sid } = await openSession(fake, { shell: "cmd.exe", args: [] });
    expect((await manager.awaitShellReady(owner, sid, [], SIG())).ok).toBe(true);
    expect(fake.writes).toHaveLength(0);
  });
  it("falls back and flushes buffered output when the probe times out", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakePty();
      fake.write = (data) => fake.writes.push(data);
      const { manager, owner, sid } = await openSession(fake);
      const rp = manager.awaitShellReady(owner, sid, ["-l"], SIG());
      fake.emitData("login banner\r\n");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await rp).toEqual({ ok: false, code: "timeout" });
      expect(manager.snapshotAgent(owner, sid) ?? "").toContain("login banner");
      expect(manager.writeAgent(owner, sid, "echo late\r").ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not duplicate pre-marker output when banner, marker, and trailing arrive in separate callbacks", async () => {
    const fake = makeFakePty();
    fake.write = (data) => {
      fake.writes.push(data);
      const m = data.match(PROBE_RE);
      if (m) {
        queueMicrotask(() => {
          fake.emitData("login banner\r\n");
          fake.emitData(`${m[1]}\n`);
          fake.emitData("trailing output\r\n");
        });
      }
    };
    const { manager, owner, sid } = await openSession(fake);
    expect((await manager.awaitShellReady(owner, sid, ["-l"], SIG())).ok).toBe(true);
    const snap = manager.snapshotAgent(owner, sid) ?? "";
    expect(snap).toContain("trailing output");
    expect(snap.match(/login banner/g)).toHaveLength(1);
  });
  it("settles the probe immediately when the terminal exits during readiness", async () => {
    const fake = makeFakePty();
    fake.write = (data) => fake.writes.push(data);
    const { manager, owner, sid } = await openSession(fake);
    const rp = manager.awaitShellReady(owner, sid, ["-l"], SIG());
    fake.emitExit(0);
    const start = Date.now();
    const result = await rp;
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(3_000);
  });
  it("forwards output unchanged after the probe settles (no draining layer)", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakePty();
      fake.write = (data) => {
        fake.writes.push(data);
        const m = data.match(PROBE_RE);
        if (m) {
          queueMicrotask(() => fake.emitData("login banner\r\n"));
        }
      };
      const { manager, owner, sid } = await openSession(fake);
      const rp = manager.awaitShellReady(owner, sid, ["-l"], SIG());
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await rp;
      expect(result).toEqual({ ok: false, code: "timeout" });
      // After settle the probe is detached: unterminated output must flow
      // through immediately, not be held in a draining buffer.
      fake.emitData("printf x");
      await Promise.resolve();
      const snap = manager.snapshotAgent(owner, sid) ?? "";
      expect(snap).toContain("printf x");
      expect(snap).toContain("login banner");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not hold unterminated output after a successful handshake", async () => {
    const fake = makeFakePty();
    echoShell(fake);
    const { manager, owner, sid } = await openSession(fake);
    expect((await manager.awaitShellReady(owner, sid, ["-l"], SIG())).ok).toBe(true);
    // No-newline output after settle must appear immediately.
    fake.emitData("partial-no-newline");
    await Promise.resolve();
    expect(manager.snapshotAgent(owner, sid) ?? "").toContain("partial-no-newline");
  });
});
