// Status-all report table tests cover agent, channel detail, and overview row construction.
import { describe, expect, it } from "vitest";
import { buildStatusAgentTableRows, buildStatusChannelDetailSections } from "./report-tables.js";

describe("status-all report tables", () => {
  it("builds agent rows with bootstrap semantics", () => {
    expect(
      buildStatusAgentTableRows({
        agentStatus: {
          agents: [
            {
              id: "main",
              name: "Primary",
              bootstrapPending: true,
              sessionsCount: 2,
              lastActiveAgeMs: 12_000,
              sessionsPath: "/tmp/main.json",
            },
            {
              id: "ops",
              bootstrapPending: false,
              sessionsCount: 0,
              lastActiveAgeMs: null,
              sessionsPath: "/tmp/ops.json",
            },
          ],
        },
        ok: (value) => `ok(${value})`,
        warn: (value) => `warn(${value})`,
      }),
    ).toEqual([
      {
        Agent: "main (Primary)",
        BootstrapFile: "warn(PRESENT)",
        Sessions: "2",
        Active: "just now",
        Store: "/tmp/main.json",
      },
      {
        Agent: "ops",
        BootstrapFile: "ok(ABSENT)",
        Sessions: "0",
        Active: "unknown",
        Store: "/tmp/ops.json",
      },
    ]);
  });

  it("builds colored detail table sections", () => {
    const [section] = buildStatusChannelDetailSections({
      details: [
        {
          title: "Channel detail",
          columns: ["Channel", "Status", "Notes"],
          rows: [{ Channel: "quietchat", Status: "WARN", Notes: "setup" }],
        },
      ],
      ok: (value) => `ok(${value})`,
      warn: (value) => `warn(${value})`,
    });

    expect(section).toEqual({
      title: "Channel detail",
      columns: [
        { key: "Channel", header: "Channel", flex: false, minWidth: 10 },
        { key: "Status", header: "Status", flex: false, minWidth: 10 },
        { key: "Notes", header: "Notes", flex: true, minWidth: 28 },
      ],
      rows: [{ Channel: "quietchat", Status: "warn(WARN)", Notes: "setup" }],
    });
  });

  it("shows a refused agent and repair guidance without claiming its session count is known", () => {
    const [row] = buildStatusAgentTableRows({
      agentStatus: {
        agents: [
          {
            id: "cleaner",
            status: "degraded",
            sessionsCount: 0,
            sessionsPath: "/synthetic/cleaner.sqlite",
            admissionRefusal: {
              reason: "Database belongs to main.",
              repairHint: "Quarantine the cleaner copy and restart.",
            },
          },
        ],
      },
      ok: (value) => value,
      warn: (value) => value,
    });
    expect(row).toMatchObject({
      Agent: "cleaner (degraded)",
      Sessions: "unavailable",
      Active: "refused",
    });
    expect(row?.Store).toContain("Database belongs to main.");
    expect(row?.Store).toContain("Quarantine the cleaner copy and restart.");
  });

  it("strips terminal control sequences from agent and channel detail rows", () => {
    // Agent names/admission text and detail titles/fields are operator- or
    // runtime-supplied; status --all must not echo embedded ESC/OSC sequences.
    const esc = "\u001b[31m";
    const reset = "\u001b[0m";
    const osc = "\u001b]0;hacked\u0007";
    const [agent] = buildStatusAgentTableRows({
      agentStatus: {
        agents: [
          {
            id: "evil",
            name: `${esc}Primary${reset}`,
            status: "degraded",
            sessionsCount: 0,
            sessionsPath: `${esc}/tmp/evil${reset}`,
            admissionRefusal: {
              reason: `${esc}Database belongs to main.${reset}`,
              repairHint: `${osc}Quarantine${esc}`,
            },
          },
        ],
      },
      ok: (value) => value,
      warn: (value) => value,
    });
    if (agent) {
      for (const value of Object.values(agent)) {
        expect(hasControlChars(value)).toBe(false);
      }
      expect(agent.Agent).toBe("evil (Primary) (degraded)");
      expect(agent.Store).toContain("Database belongs to main.");
      expect(agent.Store).toContain("Quarantine");
      expect(agent.Store).toContain("\n");
    }
    const [section] = buildStatusChannelDetailSections({
      details: [
        {
          title: `${esc}evil accounts${reset}`,
          columns: ["Account", "Status", "Notes"],
          rows: [{ Account: `${esc}acct-1${reset}`, Status: "WARN", Notes: `${osc}notes${esc}` }],
        },
      ],
      ok: (value) => value,
      warn: (value) => value,
    });
    if (section) {
      expect(hasControlChars(section.title)).toBe(false);
      for (const row of section.rows) {
        for (const value of Object.values(row)) {
          expect(hasControlChars(value)).toBe(false);
        }
      }
      expect(section.title).toBe("evil accounts");
      // The row's inferred type exposes only optional Status after the record
      // spread, so assert via toMatchObject rather than property access.
      expect(section.rows[0]).toMatchObject({ Account: "acct-1", Notes: "notes", Status: "WARN" });
    }
  });

  function hasControlChars(value: string): boolean {
    return value.includes("\u001b") || value.includes("\u0007");
  }
});
