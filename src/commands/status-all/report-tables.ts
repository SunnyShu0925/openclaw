import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import type { buildChannelsTable } from "./channels.js";
import { formatTimeAgo } from "./format.js";

type AgentStatusLike = {
  agents: Array<{
    id: string;
    status?: "degraded";
    admissionRefusal?: { reason: string; repairHint: string };
    name?: string | null;
    bootstrapPending?: boolean | null;
    sessionsCount: number;
    lastActiveAgeMs?: number | null;
    sessionsPath: string;
  }>;
};

export const statusOverviewTableColumns = [
  { key: "Item", header: "Item", minWidth: 10 },
  { key: "Value", header: "Value", flex: true, minWidth: 24 },
] as const;

export const statusAgentsTableColumns = [
  { key: "Agent", header: "Agent", minWidth: 12 },
  { key: "BootstrapFile", header: "Bootstrap file", minWidth: 14 },
  { key: "Sessions", header: "Sessions", align: "right", minWidth: 8 },
  { key: "Active", header: "Active", minWidth: 10 },
  { key: "Store", header: "Store", flex: true, minWidth: 34 },
] as const;

export function buildStatusAgentTableRows(params: {
  agentStatus: AgentStatusLike;
  ok: (text: string) => string;
  warn: (text: string) => string;
}) {
  return params.agentStatus.agents.map((agent) => {
    const sessionsPath = sanitizeTerminalText(agent.sessionsPath);
    const name = agent.name?.trim() ? sanitizeTerminalText(agent.name.trim()) : "";
    const id = sanitizeTerminalText(agent.id);
    return {
      Agent: `${name ? `${id} (${name})` : id}${agent.status === "degraded" ? params.warn(" (degraded)") : ""}`,
      BootstrapFile:
        agent.bootstrapPending === true
          ? params.warn("PRESENT")
          : agent.bootstrapPending === false
            ? params.ok("ABSENT")
            : "unknown",
      Sessions: agent.status === "degraded" ? "unavailable" : String(agent.sessionsCount),
      Active:
        agent.status === "degraded"
          ? params.warn("refused")
          : agent.lastActiveAgeMs != null
            ? formatTimeAgo(agent.lastActiveAgeMs)
            : "unknown",
      Store: agent.admissionRefusal
        ? `${sessionsPath}\n${sanitizeTerminalText(agent.admissionRefusal.reason)}\n${sanitizeTerminalText(agent.admissionRefusal.repairHint)}`
        : sessionsPath,
    };
  });
}

export function buildStatusChannelDetailSections(params: {
  details: Awaited<ReturnType<typeof buildChannelsTable>>["details"];
  ok: (text: string) => string;
  warn: (text: string) => string;
}) {
  return params.details.map((detail) => ({
    title: sanitizeTerminalText(detail.title),
    columns: detail.columns.map((column) => ({
      key: column,
      header: column,
      // Notes can include file paths and credential source summaries; give them remaining width.
      flex: column === "Notes",
      minWidth: column === "Notes" ? 28 : 10,
    })),
    rows: detail.rows.map((row) => ({
      ...Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, sanitizeTerminalText(value)]),
      ),
      ...(row.Status === "OK"
        ? { Status: params.ok("OK") }
        : row.Status === "WARN"
          ? { Status: params.warn("WARN") }
          : {}),
    })),
  }));
}
