// Login-shell readiness probe for terminal open + initial command delivery.
//
// When an agent opens a terminal with an initial command, the command must not
// be written before the login shell has finished loading its profile and is
// ready to accept input. Writing too early truncates or mangles long commands
// (see #128696). This probe sends a unique sentinel and resolves once the
// shell echoes it back as a standalone output line, proving readiness.

import { randomUUID } from "node:crypto";
import { DEFAULT_SCROLLBACK_CHARS } from "./session-limits.js";

/** Upper bound for the readiness handshake before falling back to direct delivery. */
const TERMINAL_SHELL_READY_TIMEOUT_MS = 5_000;
/** Caps pre-marker output so a noisy login profile cannot retain unbounded state. */
const READINESS_BUFFER_CAP = DEFAULT_SCROLLBACK_CHARS;

/**
 * Line prefix + sentinel that the shell is expected to print once ready. The
 * prefix is chosen so a PTY input echo of the `printf ... '<marker>'` command
 * line cannot satisfy the scan: the echo line contains the marker but it is
 * preceded by `printf '%s\n' '`, not by a line start, so the anchored match
 * only fires on the standalone line the shell itself emits after executing
 * printf.
 */
const SHELL_READY_PREFIX = "__OC_SHELL_READY__:";

export type ShellReadinessResult =
  | { ok: true }
  | { ok: false; code: "timeout" | "aborted" | "backend_failed" };

/** A pending readiness probe attached to a live session's onData path. */
export type TerminalShellReadinessProbe = {
  /** Full sentinel line the shell is expected to emit. */
  marker: string;
  /** The exact probe command written to the PTY (used to strip its input echo). */
  probeCommand: string;
  /** Resolves once the standalone marker line is observed in the output. */
  resolve: (
    result:
      | { ok: true; markerStart: number; consumedBytes: number }
      | { ok: false; code: "timeout" | "aborted" },
  ) => void;
  /** Accumulated output scanned for the marker line. */
  buffered: string;
  /** Whether the marker has been observed. */
  done: boolean;
  /** Resolves the probe as aborted; used by terminal teardown to avoid waiting. */
  abort: () => void;
};

/**
 * Scans accumulated output for the standalone marker line. Returns the marker
 * start index and the index just past its trailing newline, or null if absent.
 * The match is anchored to a line start so the PTY input echo (which contains
 * the marker preceded by `printf '%s\n' '`) does not satisfy it.
 */
function findShellReadinessMarker(
  output: string,
  marker: string,
): { markerStart: number; consumedBytes: number } | null {
  let from = 0;
  for (;;) {
    const at = output.indexOf(marker, from);
    if (at < 0) {
      return null;
    }
    const isLineStart = at === 0 || output[at - 1] === "\n" || output[at - 1] === "\r";
    if (isLineStart) {
      let end = at + marker.length;
      if (output[end] === "\n") {
        end += 1;
      } else if (output[end] === "\r" && output[end + 1] === "\n") {
        end += 2;
      }
      return { markerStart: at, consumedBytes: end };
    }
    from = at + 1;
  }
}

/**
 * Removes lines containing `needle` from `output`. Used to strip the probe's
 * input-echo line (which contains the probe command text) so it never reaches
 * viewers or `terminal.read`.
 */
function stripLinesContaining(output: string, needle: string): string {
  if (!output.includes(needle)) {
    return output;
  }
  return output
    .split("\n")
    .filter((line) => !line.includes(needle))
    .join("\n");
}

/**
 * Strips the readiness sentinel echo from an incoming output chunk while a
 * probe is active. Returns the chunk to forward to viewers/buffer, or `null`
 * to drop it. Until the standalone marker line lands, all output is accumulated
 * into the probe buffer (so a marker split across chunks is fully stripped).
 * On match, only pre-marker shell output (with the probe's input echo removed)
 * is returned; the marker line itself and any trailing output are forwarded by
 * `runShellReadinessProbe` to guarantee a single delivery point. After the
 * probe settles (success, timeout, or abort) `runShellReadinessProbe` detaches
 * it via `attachProbe(undefined)`, so subsequent output flows through unchanged.
 */
export function forwardReadinessProbeChunk(
  probe: TerminalShellReadinessProbe | undefined,
  chunk: string,
  forward: (data: string) => void,
): void {
  if (!probe || probe.done) {
    forward(chunk);
    return;
  }
  probe.buffered += chunk;
  if (probe.buffered.length > READINESS_BUFFER_CAP) {
    probe.buffered = probe.buffered.slice(-READINESS_BUFFER_CAP);
  }
  const found = findShellReadinessMarker(probe.buffered, probe.marker);
  if (!found) {
    return;
  }
  const preMarker = probe.buffered.slice(0, found.markerStart);
  const cleaned = stripLinesContaining(preMarker, probe.probeCommand);
  if (cleaned.length > 0) {
    forward(cleaned);
  }
  const trailing = probe.buffered.slice(found.consumedBytes);
  if (trailing.length > 0) {
    forward(trailing);
  }
  probe.done = true;
  probe.resolve({ ok: true, markerStart: found.markerStart, consumedBytes: probe.buffered.length });
}

/**
 * Drives a readiness probe: creates a unique sentinel, attaches the probe so
 * the caller's onData path can strip the echo, sends the sentinel via
 * `writeProbe`, waits for the standalone echo line to resolve, then forwards
 * any output that arrived after the marker. On timeout or abort the accumulated
 * output (with the probe's input echo removed) is flushed so login banners and
 * prompts are not lost, and the caller fails the open and closes the session
 * without writing the initial command (#128696).
 */
async function runShellReadinessProbe(params: {
  attachProbe: (probe: TerminalShellReadinessProbe | undefined) => void;
  writeProbe: (command: string) => boolean;
  forwardOutput: (data: string) => void;
  signal: AbortSignal;
  isLoginShell: boolean;
  timeoutMs?: number;
}): Promise<ShellReadinessResult> {
  const { attachProbe, writeProbe, forwardOutput, signal, isLoginShell } = params;
  if (!isLoginShell) {
    return { ok: true };
  }
  const timeoutMs = params.timeoutMs ?? TERMINAL_SHELL_READY_TIMEOUT_MS;
  const marker = `${SHELL_READY_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const probeCommand = `printf '%s\\n' '${marker}'`;
  const probe: TerminalShellReadinessProbe = {
    marker,
    probeCommand,
    resolve: () => undefined,
    buffered: "",
    done: false,
    abort: () => undefined,
  };
  let resolveProbe!: TerminalShellReadinessProbe["resolve"];
  probe.resolve = (result) => resolveProbe(result);
  probe.abort = () => {
    if (!probe.done) {
      probe.done = true;
      probe.resolve({ ok: false, code: "aborted" });
    }
  };
  const settled = new Promise<
    | { ok: true; markerStart: number; consumedBytes: number }
    | { ok: false; code: "timeout" | "aborted" }
  >((resolve) => {
    resolveProbe = resolve;
  });
  attachProbe(probe);
  if (signal.aborted) {
    attachProbe(undefined);
    return { ok: false, code: "aborted" };
  }
  signal.addEventListener("abort", probe.abort, { once: true });
  if (!writeProbe(`${probeCommand}\r`)) {
    attachProbe(undefined);
    signal.removeEventListener("abort", probe.abort);
    return { ok: false, code: "backend_failed" };
  }
  const timer = setTimeout(() => {
    if (!probe.done) {
      probe.done = true;
      probe.resolve({ ok: false, code: "timeout" });
    }
  }, timeoutMs);
  try {
    const result = await settled;
    probe.done = true;
    if (result.ok) {
      if (result.consumedBytes < probe.buffered.length) {
        const trailing = probe.buffered.slice(result.consumedBytes);
        if (trailing.length > 0) {
          forwardOutput(trailing);
        }
      }
      return { ok: true };
    }
    if (probe.buffered.length > 0) {
      const cleaned = stripLinesContaining(probe.buffered, probeCommand);
      if (cleaned.length > 0) {
        forwardOutput(cleaned);
      }
    }
    return { ok: false, code: result.code };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", probe.abort);
    attachProbe(undefined);
  }
}

/** Session shape needed by {@link runAgentShellReadiness}. */
export type ShellReadinessSession = {
  closed: boolean;
  readinessProbe?: TerminalShellReadinessProbe;
  output: { push: (data: string) => void };
};

/**
 * Wraps {@link runShellReadinessProbe} for the session manager: attaches the
 * probe to the session, writes the sentinel via the caller-supplied callback
 * (so the session manager's own write path is used), and forwards flushed
 * output to the session's output controller.
 */
export async function runAgentShellReadiness(
  session: ShellReadinessSession | undefined,
  args: string[],
  signal: AbortSignal,
  writeProbe: (command: string) => boolean,
): Promise<ShellReadinessResult> {
  if (!session) {
    return { ok: false, code: "backend_failed" };
  }
  return runShellReadinessProbe({
    attachProbe: (p) => (session.readinessProbe = p),
    writeProbe,
    forwardOutput: (d) => !session.closed && session.output.push(d),
    isLoginShell: args.includes("-l"),
    signal,
  });
}
