// Status-all channels table tests verify gateway issue overlays and channel row rendering.
import { describe, expect, it } from "vitest";
import { buildStatusChannelsTableRows } from "./channels-table.js";

describe("buildStatusChannelsTableRows", () => {
  const ok = (text: string) => `[ok:${text}]`;
  const warn = (text: string) => `[warn:${text}]`;
  const muted = (text: string) => `[muted:${text}]`;
  const accentDim = (text: string) => `[setup:${text}]`;

  it("overlays gateway issues and preserves off rows", () => {
    expect(
      buildStatusChannelsTableRows({
        rows: [
          {
            id: "signal",
            label: "Signal",
            enabled: true,
            state: "ok",
            detail: "configured",
          },
          {
            id: "discord",
            label: "Discord",
            enabled: false,
            state: "off",
            detail: "disabled",
          },
        ],
        channelIssues: [
          { channel: "signal", message: "" },
          { channel: "signal", message: "signal-cli unreachable from gateway runtime" },
          { channel: "discord", message: "should not override off" },
        ],
        ok,
        warn,
        muted,
        accentDim,
        formatIssueMessage: (message) => message.slice(0, 20),
      }),
    ).toEqual([
      {
        Channel: "Signal",
        Enabled: "[ok:ON]",
        State: "[warn:WARN]",
        Detail: "configured · [warn:gateway: ]",
      },
      {
        Channel: "Discord",
        Enabled: "[muted:OFF]",
        State: "[muted:OFF]",
        Detail: "disabled · [warn:gateway: should not override ]",
      },
    ]);
  });

  it("strips terminal control sequences from channel labels, details, and issue messages", () => {
    // External channel labels/messages must not echo ESC/BEL/OSC into the table.
    const esc = "\u001b[31m";
    const reset = "\u001b[0m";
    const osc = "\u001b]0;hacked\u0007";
    const rows = buildStatusChannelsTableRows({
      rows: [
        {
          id: "evil",
          label: `${esc}Evil Channel${reset}`,
          enabled: true,
          state: "warn",
          detail: `${esc}remote error${reset}`,
        },
      ],
      channelIssues: [{ channel: "evil", message: `${esc}gateway down${osc}` }],
      ok,
      warn,
      muted,
      accentDim,
      formatIssueMessage: (message) => message.slice(0, 20),
    });
    for (const row of rows) {
      for (const value of Object.values(row)) {
        expect(hasControlChars(value)).toBe(false);
      }
    }
    expect(rows[0]?.Channel).toBe("Evil Channel");
    expect(rows[0]?.Detail).toBe("remote error · [warn:gateway: gateway down]");
  });

  function hasControlChars(value: string): boolean {
    return value.includes("\u001b") || value.includes("\u0007");
  }
});
